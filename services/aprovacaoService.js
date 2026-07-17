'use strict';
/**
 * services/aprovacaoService.js — CH Geladas PDV
 * ═══════════════════════════════════════════════════════════════════
 * Fluxo:  pendente → (controlador) → aprovada → (validador) → validada
 *
 * REGRA INVIOLÁVEL:
 *   Uma venda JAMAIS muda para "validada" antes da baixa de estoque
 *   ser executada e confirmada.
 *
 *   Ordem de execução:
 *     1. Verifica estoque disponível (bloqueia se insuficiente)
 *     2. baixarEstoqueVendaLote() ← executa a baixa
 *     3. Somente após confirmação → muda status para "validada"
 *     4. Dispara eventos (financeiro, fiado, sync)
 */

(function () {
  const { Store, AuthService, Utils, EventBus } = window.CH;

  let _processandoLote = false;

  function _perm(modulo) {
    const role = AuthService.getRole();
    if (['adm', 'admin'].includes(role)) return true;
    return window.CH.PermissoesService
      ? window.CH.PermissoesService.temAcesso(role, modulo)
      : false;
  }

  function _sync(vendaId) {
    if (!window.CH.SyncQueue) return;
    const v = Store.getVendas().find(v => v.id === vendaId);
    if (v) window.CH.SyncQueue.enqueue('atualizar', 'vendas', [v]);
  }

  function _syncLote(vendaIds) {
    if (!window.CH.SyncQueue || !vendaIds.length) return;
    const todas = Store.getVendas();
    const lote  = vendaIds.map(id => todas.find(v => v.id === id)).filter(Boolean);
    if (lote.length) window.CH.SyncQueue.enqueue('atualizar', 'vendas', lote);
  }

  // Marca a venda como erro_validacao, mantendo o estado anterior preservado em _statusAnterior
  // para que "Tentar novamente" e "Resolver manualmente" saibam pra onde reverter/avançar.
  function _marcarErroValidacao(vendaId, motivo, agora, operador) {
    Store.mutateVendas(list => {
      const v = list.find(v => v.id === vendaId);
      if (v && v.status !== 'erro_validacao') {
        v._statusAnterior   = v.status; // sempre 'aprovada' neste fluxo, mas guarda por segurança
        v.status             = 'erro_validacao';
        v.erroValidacaoEm    = agora;
        v.erroValidacaoMotivo = motivo;
        v.erroValidacaoOperador = operador;
      }
    });
    _sync(vendaId);
    EventBus.emit('venda:erro_validacao', { vendaId, motivo, operador });
  }

  // ── Queries ───────────────────────────────────────────────────────
  function getPendentes() {
    return Store.getVendas()
      .filter(v => v.status === 'pendente')
      .sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));
  }
  function getAprovadas() {
    return Store.getVendas()
      .filter(v => v.status === 'aprovada')
      .sort((a, b) => (b.aprovadaEm || '').localeCompare(a.aprovadaEm || ''));
  }
  function getRejeitadas() {
    return Store.getVendas()
      .filter(v => v.status === 'rejeitada')
      .sort((a, b) => (b.rejeitadaEm || '').localeCompare(a.rejeitadaEm || ''));
  }
  function getValidadas() {
    return Store.getVendas()
      .filter(v => v.status === 'validada')
      .sort((a, b) => (b.validadaEm || '').localeCompare(a.validadaEm || ''));
  }
  function getErrosValidacao() {
    return Store.getVendas()
      .filter(v => v.status === 'erro_validacao')
      .sort((a, b) => (b.erroValidacaoEm || '').localeCompare(a.erroValidacaoEm || ''));
  }
  function contarPendentes() { return getPendentes().length; }
  function contarAprovadas() { return getAprovadas().length; }
  function contarErrosValidacao() { return getErrosValidacao().length; }

  // ── APROVAR individual (pendente → aprovada) ──────────────────────
  function aprovarVenda(vendaId) {
    if (!_perm('aprovacao_controle'))
      throw new Error('Sem permissão para aprovar vendas');

    const venda = Store.getVendas().find(v => v.id === vendaId);
    if (!venda) throw new Error('Venda não encontrada');
    if (venda.status !== 'pendente')
      throw new Error(`Venda está "${venda.status}", esperado "pendente"`);

    // Valida disponibilidade real (estoqueAtual − reservas de outras vendas)
    // Câmbios não movimentam estoque — pula verificação
    const ES = window.CH.EstoqueService;
    if (ES && !venda._cambio) {
      const reservas = ES.getReservas();
      for (const item of venda.itens || []) {
        const prod = ES.getProduto(item.prodId);
        if (!prod || prod.controlaEstoque === false) continue;
        const pack  = prod.packs?.find(pk => pk.label === item.label || (pk.qtd + 'x') === item.label);
        const qtdUn = item.label === 'UNID' ? item.qtd : item.qtd * (pack?.qtd || 1);
        const reservaOutros = Object.entries(reservas)
          .filter(([vid]) => vid !== vendaId)
          .reduce((s, [, r]) => s + (r[item.prodId] || 0), 0);
        const disponivel = Math.max(0, (prod.estoqueAtual ?? 0) - reservaOutros);
        if (disponivel < qtdUn) {
          throw new Error(
            `Estoque insuficiente para "${prod.nome}": ` +
            `disponível ${disponivel} (${prod.estoqueAtual} físico − ${reservaOutros} reservados), ` +
            `necessário ${qtdUn}`
          );
        }
      }
    }

    Store.mutateVendas(list => {
      const v = list.find(v => v.id === vendaId);
      if (v) {
        v.status      = 'aprovada';
        v.aprovadaEm  = Utils.nowISO();
        v.aprovadaPor = AuthService.getNome();
      }
    });

    _sync(vendaId);
    EventBus.emit('venda:aprovada', { vendaId, operador: AuthService.getNome() });
    return true;
  }

  // ── REJEITAR (pendente|aprovada → rejeitada) ──────────────────────
  function rejeitarVenda(vendaId, motivo = '') {
    const podeC = _perm('aprovacao_controle');
    const podeV = _perm('aprovacao_validacao');
    if (!podeC && !podeV) throw new Error('Sem permissão para rejeitar vendas');

    const venda = Store.getVendas().find(v => v.id === vendaId);
    if (!venda) throw new Error('Venda não encontrada');
    if (!['pendente', 'aprovada', 'erro_validacao'].includes(venda.status))
      throw new Error(`Venda "${venda.status}" não pode ser rejeitada`);

    Store.mutateVendas(list => {
      const v = list.find(v => v.id === vendaId);
      if (v) {
        v.status         = 'rejeitada';
        v.rejeitadaEm    = Utils.nowISO();
        v.rejeitadaPor   = AuthService.getNome();
        v.motivoRejeicao = motivo;
      }
    });

    window.CH.EstoqueService?.liberarReserva?.(vendaId);

    if (venda._fiado && venda._fiadoClienteId) {
      EventBus.emit('fiado:lancamento:rejeitado', {
        vendaId,
        clienteId: venda._fiadoClienteId,
        valor:     venda.total,
        motivo,
        operador:  AuthService.getNome(),
      });
    }

    _sync(vendaId);
    EventBus.emit('venda:rejeitada', { vendaId, motivo, operador: AuthService.getNome() });
    return true;
  }

  // ── VALIDAR individual (aprovada → validada) ──────────────────────
  async function validarVenda(vendaId) {
    if (!_perm('aprovacao_validacao'))
      throw new Error('Sem permissão para validar vendas');

    const venda = Store.getVendas().find(v => v.id === vendaId);
    if (!venda) throw new Error('Venda não encontrada');
    if (venda.status !== 'aprovada')
      throw new Error(`Venda está "${venda.status}", esperado "aprovada"`);
    if (venda._baixouEstoque)
      throw new Error('Estoque desta venda já foi baixado — reprocessamento bloqueado');

    // ── PASSO 1: Verifica estoque disponível ──────────────────────
    // Câmbios não movimentam estoque — pula verificação e baixa
    const ES = window.CH.EstoqueService;
    if (ES && !venda._cambio) {
      const errosEstoque = [];
      for (const item of venda.itens || []) {
        const prod = ES.getProduto(item.prodId);
        if (!prod || prod.controlaEstoque === false) continue;
        const pack  = prod.packs?.find(pk => pk.label === item.label || (pk.qtd + 'x') === item.label);
        const qtdUn = item.label === 'UNID' ? item.qtd : item.qtd * (pack?.qtd || 1);
        const disponivel = prod.estoqueAtual ?? prod.qtdUn ?? 0;
        if (disponivel < qtdUn)
          errosEstoque.push(`"${prod.nome}": disponível ${disponivel}, necessário ${qtdUn}`);
      }
      if (errosEstoque.length > 0)
        throw new Error(`Estoque insuficiente:\n${errosEstoque.join('\n')}`);
    }

    // ── PASSO 2: Libera reserva ───────────────────────────────────
    if (!venda._cambio) ES?.liberarReserva?.(venda.id);

    // ── PASSO 3: BAIXA DE ESTOQUE — ANTES DE MUDAR STATUS ─────────
    let baixaOk    = true;   // câmbio sempre ok (sem estoque)
    let baixaErros = [];

    if (!venda._cambio) {
      baixaOk = false;
      if (ES?.baixarEstoqueVendaLote) {
        try {
          const resultado = await ES.baixarEstoqueVendaLote(venda);
          if (resultado.jaProcessado) {
            console.info(`[AprovacaoService] Venda ${vendaId}: guard atômico bloqueou repetição de baixa (já estava baixada).`);
          }
          baixaOk    = resultado.ok || resultado.localFallback || false;
          baixaErros = resultado.erros || [];
          if (!resultado.ok && !resultado.localFallback && resultado.itensProcessados === 0) {
            throw new Error(`Baixa falhou: ${resultado.erros?.join('; ')}`);
          }
        } catch (e) {
          console.error('[AprovacaoService] baixarEstoqueVendaLote falhou:', e.message);
          throw new Error(`Validação bloqueada: ${e.message}`);
        }
      } else {
        // Fallback local direto
        Store.mutateEstoque(estoque => {
          (venda.itens || []).forEach(item => {
            const prod = estoque.find(p => p.id === item.prodId);
            if (!prod || prod.controlaEstoque === false) return;
            const qtdDesc = item.label === 'UNID'
              ? item.qtd
              : item.qtd * (prod.packs?.find(pk => pk.label === item.label)?.qtd || 1);
            prod.qtdUn = Math.max(0, (prod.qtdUn || 0) - qtdDesc);
            prod.estoqueAtual = prod.qtdUn;
          });
        });
        baixaOk = true;
      }
    }

    // ── PASSO 4: MUDA STATUS APÓS CONFIRMAÇÃO DA BAIXA ────────────
    Store.mutateVendas(list => {
      const v = list.find(v => v.id === vendaId);
      if (v) {
        v.status      = 'validada';
        v.validadaEm  = Utils.nowISO();
        v.validadaPor = AuthService.getNome();
        v._baixaOk    = baixaOk;
        v._baixaErros = baixaErros.length > 0 ? baixaErros : undefined;
        v._baixouEstoque = !venda._cambio; // true só quando realmente baixou (câmbio não mexe em estoque)
      }
    });

    if (!_processandoLote) _sync(vendaId);

    // ── PASSO 5: Efetiva débito fiado ─────────────────────────────
    const vendaAtualizada = Store.getVendas().find(v => v.id === vendaId);
    if (vendaAtualizada?._fiado && vendaAtualizada._fiadoClienteId) {
      Store.mutateFiado(fiado => {
        const cx = fiado.find(x => x.id === vendaAtualizada._fiadoClienteId);
        if (!cx) return;
        cx.saldo = (cx.saldo || 0) + (vendaAtualizada.total || 0);
        if (!Array.isArray(cx.movimentacoes)) cx.movimentacoes = [];
        cx.movimentacoes.unshift({
          id:          Utils.generateId(),
          tipo:        'fiado',
          descricao:   vendaAtualizada._fiadoDesc || vendaAtualizada.itens?.[0]?.nome || 'Compra fiado',
          valor:       vendaAtualizada.total || 0,
          vendaId:     vendaAtualizada.id,
          validadoPor: AuthService.getNome(),
          criadoEm:    Utils.nowISO(),
        });
        if (cx.limite > 0 && cx.saldo >= cx.limite) cx.bloqueado = true;
      });
      // Sincronização de 'fiado' já acontece por documento individual
      // dentro de Store.mutateFiado() — não repetir aqui (repetir
      // ressuscitaria o documento único antigo que a migração apagou).
    }

    // ── PASSO 6: Eventos ──────────────────────────────────────────
    if (!_processandoLote) {
      const vendaFinal = Store.getVendas().find(v => v.id === vendaId) || venda;
      EventBus.emit('venda:finalizada', vendaFinal);
      EventBus.emit('venda:validada', vendaFinal);
    }

    console.info(`[AprovacaoService] ✓ Venda ${vendaId} validada (baixa: ${baixaOk ? 'OK' : 'PARCIAL'})`);
    return true;
  }

  // ── TENTAR NOVAMENTE (erro_validacao → aprovada → tenta validar de novo) ──
  // Reverte a venda para 'aprovada' e chama validarVenda novamente.
  // Útil quando o erro foi temporário (rede instável) ou o estoque já foi corrigido.
  async function tentarNovamenteValidacao(vendaId) {
    if (!_perm('aprovacao_validacao'))
      throw new Error('Sem permissão para validar vendas');

    const venda = Store.getVendas().find(v => v.id === vendaId);
    if (!venda) throw new Error('Venda não encontrada');
    if (venda.status !== 'erro_validacao')
      throw new Error(`Venda está "${venda.status}", esperado "erro_validacao"`);

    Store.mutateVendas(list => {
      const v = list.find(v => v.id === vendaId);
      if (v) {
        v.status = 'aprovada';
        // limpa rastro do erro anterior (mantém histórico no log de auditoria, não na venda)
        delete v.erroValidacaoEm;
        delete v.erroValidacaoMotivo;
        delete v.erroValidacaoOperador;
      }
    });
    _sync(vendaId);

    return validarVenda(vendaId);
  }

  // ── RESOLVER MANUALMENTE (erro_validacao → validada, sem repetir a baixa) ──
  // Para quando o admin já ajustou o estoque na mão e quer apenas finalizar a venda,
  // sem que o sistema tente baixar o estoque de novo (evitaria baixa duplicada).
  function resolverManualmenteValidacao(vendaId, justificativa = '') {
    if (!_perm('aprovacao_validacao'))
      throw new Error('Sem permissão para validar vendas');
    if (!justificativa.trim())
      throw new Error('Justificativa obrigatória para resolução manual');

    const venda = Store.getVendas().find(v => v.id === vendaId);
    if (!venda) throw new Error('Venda não encontrada');
    if (venda.status !== 'erro_validacao')
      throw new Error(`Venda está "${venda.status}", esperado "erro_validacao"`);

    const agora    = Utils.nowISO();
    const operador = AuthService.getNome();

    Store.mutateVendas(list => {
      const v = list.find(v => v.id === vendaId);
      if (v) {
        v.status              = 'validada';
        v.validadaEm           = agora;
        v.validadaPor          = operador;
        v._baixaOk             = false;
        v._baixouEstoque       = true; // admin já ajustou o estoque manualmente — bloqueia reprocessamento
        v._resolvidaManualmente = true;
        v._justificativaManual = justificativa;
        delete v.erroValidacaoEm;
        delete v.erroValidacaoMotivo;
        delete v.erroValidacaoOperador;
      }
    });

    window.CH.AuditService?.registrar?.('resolucao_manual', 'aprovacao', {
      depois:  { vendaId, justificativa },
      resumo:  `Venda ${vendaId} validada manualmente sem baixa automática — ${justificativa}`,
    });

    _sync(vendaId);

    // Financeiro e fiado seguem o mesmo caminho de uma validação normal
    const FS = window.CH.FinanceiroService;
    if (FS) FS.registrarReceita(venda);

    if (venda._fiado && venda._fiadoClienteId) {
      Store.mutateFiado(fiado => {
        const cx = fiado.find(x => x.id === venda._fiadoClienteId);
        if (!cx) return;
        cx.saldo = (cx.saldo || 0) + (venda.total || 0);
        if (!Array.isArray(cx.movimentacoes)) cx.movimentacoes = [];
        cx.movimentacoes.unshift({
          id: Utils.generateId(), tipo: 'fiado',
          descricao: venda._fiadoDesc || venda.itens?.[0]?.nome || 'Compra fiado',
          valor: venda.total || 0, vendaId: venda.id,
          validadoPor: operador, criadoEm: agora,
        });
        if (cx.limite > 0 && cx.saldo >= cx.limite) cx.bloqueado = true;
      });
      // Sincronização de 'fiado' já acontece por documento individual
      // dentro de Store.mutateFiado() — não repetir aqui.
    }

    const vendaFinal = Store.getVendas().find(v => v.id === vendaId) || venda;
    EventBus.emit('venda:finalizada', vendaFinal);
    EventBus.emit('venda:validada', vendaFinal);

    console.info(`[AprovacaoService] ⚠ Venda ${vendaId} resolvida manualmente (sem baixa automática)`);
    return true;
  }

  // ── APROVAR EM LOTE ───────────────────────────────────────────────
  function aprovarTodas() {
    if (!_perm('aprovacao_controle'))
      throw new Error('Sem permissão para aprovar vendas');

    const pendentes = getPendentes();
    if (!pendentes.length) return { total: 0, erros: [] };

    const agora    = Utils.nowISO();
    const operador = AuthService.getNome();
    const ids      = pendentes.map(v => v.id);
    const erros    = [];

    _processandoLote = true;
    try {
      Store.mutateVendas(list => {
        ids.forEach(id => {
          const v = list.find(v => v.id === id);
          if (v && v.status === 'pendente') {
            v.status      = 'aprovada';
            v.aprovadaEm  = agora;
            v.aprovadaPor = operador;
          }
        });
      });

      _syncLote(ids);
      EventBus.emit('venda:aprovada:lote', { total: ids.length, operador });

    } catch (e) {
      erros.push({ erro: e.message });
    } finally {
      _processandoLote = false;
    }

    return { total: pendentes.length, erros };
  }

  // ── VALIDAR EM LOTE ───────────────────────────────────────────────
  async function validarTodas() {
    if (!_perm('aprovacao_validacao'))
      throw new Error('Sem permissão para validar vendas');

    const aprovadas = getAprovadas();
    if (!aprovadas.length) return { total: 0, sucesso: 0, erros: [] };

    const agora    = Utils.nowISO();
    const operador = AuthService.getNome();
    const erros    = [];
    const validadas = [];
    const ES        = window.CH.EstoqueService;

    _processandoLote = true;
    try {
      for (const venda of aprovadas) {
        try {
          // PASSO 1: Verifica estoque (câmbios pulam — não movimentam estoque)
          if (venda._baixouEstoque) {
            erros.push({ id: venda.id, erro: 'Estoque já baixado — reprocessamento bloqueado' });
            continue;
          }
          if (ES && !venda._cambio) {
            const errosEstoque = [];
            for (const item of venda.itens || []) {
              const prod = ES.getProduto(item.prodId);
              if (!prod || prod.controlaEstoque === false) continue;
              const pack  = prod.packs?.find(pk => pk.label === item.label || (pk.qtd + 'x') === item.label);
              const qtdUn = item.label === 'UNID' ? item.qtd : item.qtd * (pack?.qtd || 1);
              const disponivel = prod.estoqueAtual ?? prod.qtdUn ?? 0;
              if (disponivel < qtdUn)
                errosEstoque.push(`"${prod.nome}": disponível ${disponivel}, necessário ${qtdUn}`);
            }
            if (errosEstoque.length > 0) {
              const motivo = `Estoque insuficiente: ${errosEstoque.join('; ')}`;
              erros.push({ id: venda.id, erro: motivo });
              _marcarErroValidacao(venda.id, motivo, agora, operador);
              continue;
            }
          }

          // PASSO 2: Libera reserva (câmbios pulam)
          if (!venda._cambio) ES?.liberarReserva?.(venda.id);

          // PASSO 3: Baixa de estoque (câmbios pulam)
          let baixaOk    = true;   // câmbio ok sem baixa
          let baixaErros = [];

          if (!venda._cambio) {
            baixaOk = false;
            if (ES?.baixarEstoqueVendaLote) {
              const res = await ES.baixarEstoqueVendaLote(venda);
              if (res.jaProcessado) {
                console.info(`[AprovacaoService] Venda ${venda.id}: guard atômico bloqueou repetição de baixa (já estava baixada).`);
              }
              baixaOk    = res.ok && !res.erros?.length;
              baixaErros = res.erros || [];

              if (!baixaOk) {
                const motivo = res.localFallback
                  ? `Baixa aplicada apenas localmente (sem confirmação do Firebase): ${baixaErros.join('; ') || 'motivo desconhecido'}`
                  : `Baixa falhou ou parcial: ${baixaErros.join('; ') || 'erro desconhecido'}`;
                erros.push({ id: venda.id, erro: motivo });
                _marcarErroValidacao(venda.id, motivo, agora, operador);
                continue;
              }
            } else {
              Store.mutateEstoque(estoque => {
                (venda.itens || []).forEach(item => {
                  const prod = estoque.find(p => p.id === item.prodId);
                  if (!prod || prod.controlaEstoque === false) return;
                  const qtdDesc = item.label === 'UNID'
                    ? item.qtd
                    : item.qtd * (prod.packs?.find(pk => pk.label === item.label)?.qtd || 1);
                  prod.qtdUn = Math.max(0, (prod.qtdUn || 0) - qtdDesc);
                  prod.estoqueAtual = prod.qtdUn;
                });
              });
              baixaOk = true;
            }
          }

          // PASSO 4: Muda status
          Store.mutateVendas(list => {
            const v = list.find(v => v.id === venda.id);
            if (v && v.status === 'aprovada') {
              v.status      = 'validada';
              v.validadaEm  = agora;
              v.validadaPor = operador;
              v._baixaOk    = baixaOk;
              v._baixaErros = baixaErros.length > 0 ? baixaErros : undefined;
              v._baixouEstoque = !venda._cambio;
            }
          });

          validadas.push(venda.id);

          // PASSO 5: Financeiro
          const FS = window.CH.FinanceiroService;
          if (FS) FS.registrarReceita(venda);

          // PASSO 6: Fiado
          if (venda._fiado && venda._fiadoClienteId) {
            Store.mutateFiado(fiado => {
              const cx = fiado.find(x => x.id === venda._fiadoClienteId);
              if (!cx) return;
              cx.saldo = (cx.saldo || 0) + (venda.total || 0);
              if (!Array.isArray(cx.movimentacoes)) cx.movimentacoes = [];
              cx.movimentacoes.unshift({
                id:          Utils.generateId(),
                tipo:        'fiado',
                descricao:   venda._fiadoDesc || venda.itens?.[0]?.nome || 'Compra fiado',
                valor:       venda.total || 0,
                vendaId:     venda.id,
                validadoPor: operador,
                criadoEm:    agora,
              });
              if (cx.limite > 0 && cx.saldo >= cx.limite) cx.bloqueado = true;
            });
          }

          console.info(`[Lote] ✓ Venda ${venda.id} validada (baixa: ${baixaOk ? 'OK' : 'PARCIAL'})`);

        } catch (e) {
          erros.push({ id: venda.id, erro: e.message });
          console.error(`[Lote] ✗ Venda ${venda.id} falhou:`, e.message);
        }
      }

      if (validadas.length > 0) _syncLote(validadas);

      // Sincronização de 'fiado' já acontece por documento individual
      // dentro de cada Store.mutateFiado() do loop acima — não repetir
      // aqui (repetir ressuscitaria o documento único antigo).

      if (validadas.length > 0) {
        EventBus.emit('venda:validada:lote', { total: validadas.length, operador, erros: erros.length });
        const vendasValidadas = Store.getVendas().filter(v => validadas.includes(v.id));
        EventBus.emit('venda:finalizada:lote', vendasValidadas);
      }

    } finally {
      _processandoLote = false;
    }

    console.info(`[AprovacaoService] Lote concluído: ${validadas.length} validadas, ${erros.length} erros`);
    return { total: aprovadas.length, sucesso: validadas.length, erros };
  }

  // ── Reversão de saldo fiado por cancelamento de venda ────────────────
  // Espelho exato do bloco "PASSO 5" acima (que aplica o débito na
  // validação) — aqui, em vez de somar, subtrai. Chamada por
  // VendasService.cancelarVenda() quando a venda cancelada é fiado e já
  // tinha o débito efetivado (ou seja, estava concluida/validada).
  //
  // LIMITAÇÃO CONHECIDA: pagamentos de fiado não são vinculados a uma
  // venda específica no sistema (só abatem o saldo geral do cliente).
  // Subtrair o total da venda do saldo, com piso em zero, é a aproximação
  // mais correta possível dado esse modelo — não é matematicamente
  // perfeito se o cliente já tiver pago parte do saldo geral dele antes
  // do cancelamento, mas evita deixar a dívida "fantasma" no ar.
  function reverterFiadoPorCancelamento(venda) {
    if (!venda?._fiado || !venda._fiadoClienteId) return null;

    let clienteEncontrado = null;
    Store.mutateFiado(fiado => {
      const cx = fiado.find(x => x.id === venda._fiadoClienteId);
      if (!cx) return;
      clienteEncontrado = cx.nome;

      cx.saldo = Math.max(0, (cx.saldo || 0) - (venda.total || 0));
      if (!Array.isArray(cx.movimentacoes)) cx.movimentacoes = [];
      cx.movimentacoes.unshift({
        id:          Utils.generateId(),
        tipo:        'estorno_cancelamento',
        descricao:   `Cancelamento da venda #${venda.id.slice(-6)}`,
        valor:       -(venda.total || 0),
        vendaId:     venda.id,
        validadoPor: AuthService.getNome(),
        criadoEm:    Utils.nowISO(),
      });

      // Reavalia o bloqueio com o saldo já revertido
      if (cx.limite > 0 && cx.saldo < cx.limite) cx.bloqueado = false;
    });

    if (!clienteEncontrado) {
      console.warn(`[AprovacaoService] Reversão de fiado: cliente ${venda._fiadoClienteId} não encontrado (venda ${venda.id})`);
    } else {
      console.info(`[AprovacaoService] Saldo fiado revertido: ${clienteEncontrado} (-${venda.total}) — venda ${venda.id} cancelada`);
    }
    return clienteEncontrado;
  }

  // Exposição
  window.CH.AprovacaoService = {
    getPendentes, getAprovadas, getRejeitadas, getValidadas, getErrosValidacao,
    contarPendentes, contarAprovadas, contarErrosValidacao,
    aprovarVenda, rejeitarVenda, validarVenda,
    tentarNovamenteValidacao, resolverManualmenteValidacao,
    aprovarTodas, validarTodas,
    reverterFiadoPorCancelamento,
    isProcessandoLote: () => _processandoLote,
  };

  console.info('%c AprovacaoService ✓  (baixa antes do status | sem IntegrityService)', 'color:#f59e0b;font-weight:bold');
})();
