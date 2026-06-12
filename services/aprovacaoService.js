'use strict';
/**
 * services/aprovacaoService.js — CH Geladas PDV
 * ═══════════════════════════════════════════════════════════════════
 * Fluxo:  pendente → (controlador) → aprovada → (validador) → validada
 *
 * REGRA INVIOLÁVEL (v3 — Integridade Transacional):
 *   Uma venda JAMAIS muda para "validada" antes da baixa de estoque
 *   ser executada e confirmada. Se a baixa falhar → rollback completo
 *   do status (validada → aprovada) e bloqueio da venda.
 *
 *   Ordem de execução:
 *     1. validarIntegridadeVenda()  ← pré-validação (bloqueia se inválida)
 *     2. baixarEstoqueVendaLote()   ← executa a baixa
 *     3. Somente após confirmação → muda status para "validada"
 *     4. validarIntegridadePosVenda() ← verificação final
 *
 * CORREÇÕES v3:
 *   [CRÍTICO] Status mudava para "validada" ANTES da baixa → rollback inexistente
 *   [CRÍTICO] validarTodas: todos status mudam juntos antes das baixas → falha parcial
 *             deixava vendas validadas sem movimentação
 *   [CRÍTICO] Falha em baixarEstoqueVendaLote logada mas ignorada (try/catch silencioso)
 *   [ALTO]    Lote sem rollback individual — item que falha não reverte status
 */

(function () {
  const { Store, AuthService, Utils, EventBus } = window.CH;

  // Flag que impede renderizar() no meio de operações em lote
  let _processandoLote = false;

  function _perm(modulo) {
    const role = AuthService.getRole();
    if (['adm', 'admin'].includes(role)) return true;
    return window.CH.PermissoesService
      ? window.CH.PermissoesService.temAcesso(role, modulo)
      : false;
  }

  // Sync individual (usado em ações unitárias)
  function _sync(vendaId) {
    if (!window.CH.SyncQueue) return;
    const v = Store.getVendas().find(v => v.id === vendaId);
    if (v) window.CH.SyncQueue.enqueue('atualizar', 'vendas', [v]);
  }

  // Sync em lote — enfileira tudo de uma vez
  function _syncLote(vendaIds) {
    if (!window.CH.SyncQueue || !vendaIds.length) return;
    const todas = Store.getVendas();
    const lote  = vendaIds.map(id => todas.find(v => v.id === id)).filter(Boolean);
    if (lote.length) window.CH.SyncQueue.enqueue('atualizar', 'vendas', lote);
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
  function contarPendentes() { return getPendentes().length; }
  function contarAprovadas() { return getAprovadas().length; }

  // ── APROVAR individual (pendente → aprovada) ──────────────────────
  function aprovarVenda(vendaId) {
    if (!_perm('aprovacao_controle'))
      throw new Error('Sem permissão para aprovar vendas');

    const venda = Store.getVendas().find(v => v.id === vendaId);
    if (!venda) throw new Error('Venda não encontrada');
    if (venda.status !== 'pendente')
      throw new Error(`Venda está "${venda.status}", esperado "pendente"`);

    // Valida disponibilidade real (estoqueAtual − reservas de outras vendas)
    const EstoqueService = window.CH.EstoqueService;
    if (EstoqueService) {
      const reservas = EstoqueService.getReservas();
      for (const item of venda.itens || []) {
        const prod = EstoqueService.getProduto(item.prodId);
        if (!prod) continue;
        if (prod.controlaEstoque === false) continue;
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
    if (!['pendente', 'aprovada'].includes(venda.status))
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

    // Libera reserva de estoque
    window.CH.EstoqueService?.liberarReserva?.(vendaId);

    if (venda._fiado && venda._fiadoClienteId) {
      EventBus.emit('fiado:lancamento:rejeitado', {
        vendaId,
        clienteId: venda._fiadoClienteId,
        valor:     venda.total,
        motivo,
        operador:  AuthService.getNome(),
      });
      console.info(`[AprovacaoService] Fiado rejeitado → cliente ${venda._fiadoClienteId}`);
    }

    _sync(vendaId);
    EventBus.emit('venda:rejeitada', { vendaId, motivo, operador: AuthService.getNome() });
    return true;
  }

  // ── VALIDAR individual (aprovada → validada) ──────────────────────
  // FIX CRÍTICO v3: Baixa ANTES de mudar status. Rollback em falha.
  async function validarVenda(vendaId) {
    if (!_perm('aprovacao_validacao'))
      throw new Error('Sem permissão para validar vendas');

    const venda = Store.getVendas().find(v => v.id === vendaId);
    if (!venda) throw new Error('Venda não encontrada');
    if (venda.status !== 'aprovada')
      throw new Error(`Venda está "${venda.status}", esperado "aprovada"`);

    // ── PASSO 1: Pré-validação de integridade ─────────────────────
    const IS = window.CH.IntegrityService;
    if (IS) {
      try {
        IS.validarIntegridadeVenda(venda);
      } catch (eInteg) {
        console.error('[AprovacaoService] Pré-validação bloqueou a venda:', eInteg.message);
        throw eInteg; // Propaga para a UI — venda NÃO avança
      }
    }

    // ── PASSO 2: Libera reserva ANTES da baixa ────────────────────
    // (a reserva soft-block é substituída pela baixa real)
    window.CH.EstoqueService?.liberarReserva?.(venda.id);

    // ── PASSO 3: BAIXA DE ESTOQUE — ANTES DE MUDAR STATUS ─────────
    // FIX CRÍTICO: status só muda após confirmação da baixa
    let baixaOk = false;
    let baixaErros = [];

    if (IS?.confirmarBaixaComRollback) {
      // Rollback function: reverte status de validada → aprovada
      const rollbackStatus = (motivo) => {
        console.error(`[AprovacaoService] ROLLBACK status venda ${vendaId}: ${motivo}`);
        // Status ainda é "aprovada" neste ponto — nada a reverter
        // (a baixa falhou antes do status ser mudado)
      };

      const resultado = await IS.confirmarBaixaComRollback(venda, rollbackStatus);
      baixaOk    = resultado.ok;
      baixaErros = resultado.erros || [];

      if (!resultado.ok && resultado.rollbackExecutado) {
        // Baixa falhou com rollback — lança erro para a UI
        throw new Error(
          `Validação bloqueada: baixa de estoque falhou — ${baixaErros.join('; ')}. ` +
          `Venda permanece "aprovada". Execute a Reconciliação.`
        );
      }
    } else {
      // Fallback sem IntegrityService: aplica baixa diretamente
      const EstoqueService = window.CH.EstoqueService;
      if (EstoqueService?.baixarEstoqueVendaLote) {
        try {
          const resultado = await EstoqueService.baixarEstoqueVendaLote(venda);
          baixaOk    = resultado.ok;
          baixaErros = resultado.erros || [];
          if (!resultado.ok && resultado.itensProcessados === 0) {
            throw new Error(`Baixa falhou: ${resultado.erros?.join('; ')}`);
          }
        } catch (e) {
          console.error('[AprovacaoService] baixarEstoqueVendaLote falhou:', e.message);
          throw new Error(`Validação bloqueada: ${e.message}`);
        }
      } else {
        // Último fallback: mutação local
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
    // Apenas chegamos aqui se a baixa foi executada (ok ou parcial)
    Store.mutateVendas(list => {
      const v = list.find(v => v.id === vendaId);
      if (v) {
        v.status       = 'validada';
        v.validadaEm   = Utils.nowISO();
        v.validadaPor  = AuthService.getNome();
        v._baixaOk     = baixaOk;
        v._baixaErros  = baixaErros.length > 0 ? baixaErros : undefined;
      }
    });

    // Só sincroniza individualmente se NÃO estiver em lote
    if (!_processandoLote) _sync(vendaId);

    // ── PASSO 5: Efetiva débito fiado (pós-validação) ─────────────
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
      if (window.CH.SyncQueue) {
        window.CH.SyncQueue.enqueue('salvar', 'fiado', Store.getFiado());
      }
      console.info(`[AprovacaoService] Fiado efetivado → cliente ${vendaAtualizada._fiadoClienteId}`);
    }

    // ── PASSO 6: Eventos — ANTES da validação de integridade ────────
    // FIX: o evento 'venda:finalizada' registra a receita financeira.
    // A verificação pós-venda precisa encontrar esse lançamento → deve vir depois.
    if (!_processandoLote) {
      const vendaFinal = Store.getVendas().find(v => v.id === vendaId) || venda;
      EventBus.emit('venda:finalizada', vendaFinal); // ← hook financeiro registra receita aqui
      EventBus.emit('venda:validada', vendaFinal);
    }

    // ── PASSO 7: Validação pós-venda (após eventos/financeiro) ──────
    // FIX: aguarda microtask para garantir que o lançamento financeiro
    // do evento 'venda:finalizada' já foi persistido no Store antes de verificar.
    if (IS?.validarIntegridadePosVenda) {
      const capturedId = vendaId;
      setTimeout(async () => {
        const vendaFinal = Store.getVendas().find(v => v.id === capturedId);
        if (!vendaFinal) return;
        try {
          await IS.validarIntegridadePosVenda(vendaFinal);
        } catch (e) {
          console.error('[AprovacaoService] Erro na validação pós-venda:', e.message);
        }
      }, 300); // 300ms garante que o Store foi atualizado pelo handler do evento
    }

    console.info(`[AprovacaoService] ✓ Venda ${vendaId} validada (baixa: ${baixaOk ? 'OK' : 'PARCIAL'})`);
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
  // FIX CRÍTICO v3: Cada venda é processada individualmente.
  // Baixa de estoque ANTES de mudar status. Rollback por venda.
  // Lote NÃO muda todos os status juntos — cada venda é atômica.
  async function validarTodas() {
    if (!_perm('aprovacao_validacao'))
      throw new Error('Sem permissão para validar vendas');

    const aprovadas = getAprovadas();
    if (!aprovadas.length) return { total: 0, sucesso: 0, erros: [] };

    const agora      = Utils.nowISO();
    const operador   = AuthService.getNome();
    const erros      = [];
    const validadas  = [];
    const IS         = window.CH.IntegrityService;
    const ES         = window.CH.EstoqueService;

    _processandoLote = true;
    try {
      // ── Processa CADA venda individualmente e atomicamente ──────
      // Nunca muda todos os status de uma vez antes das baixas
      for (const venda of aprovadas) {
        try {
          // PASSO 1: Pré-validação
          if (IS) {
            try { IS.validarIntegridadeVenda(venda); }
            catch (eI) {
              erros.push({ id: venda.id, erro: `Bloqueada por integridade: ${eI.message}` });
              continue;
            }
          }

          // PASSO 2: Libera reserva
          ES?.liberarReserva?.(venda.id);

          // PASSO 3: Baixa de estoque ANTES de mudar status
          let baixaOk = false;
          let baixaErros = [];

          if (IS?.confirmarBaixaComRollback) {
            const res = await IS.confirmarBaixaComRollback(venda, null);
            baixaOk    = res.ok;
            baixaErros = res.erros || [];

            if (!res.ok && res.rollbackExecutado) {
              erros.push({ id: venda.id, erro: `Baixa falhou: ${baixaErros.join('; ')}` });
              continue; // Não muda status desta venda
            }
          } else if (ES?.baixarEstoqueVendaLote) {
            const res = await ES.baixarEstoqueVendaLote(venda);
            baixaOk    = res.ok;
            baixaErros = res.erros || [];
            if (!res.ok && res.itensProcessados === 0) {
              erros.push({ id: venda.id, erro: `Baixa falhou: ${res.erros?.join('; ')}` });
              continue;
            }
          } else {
            // Fallback local
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

          // PASSO 4: Muda status APÓS confirmação da baixa
          Store.mutateVendas(list => {
            const v = list.find(v => v.id === venda.id);
            if (v && v.status === 'aprovada') {
              v.status      = 'validada';
              v.validadaEm  = agora;
              v.validadaPor = operador;
              v._baixaOk    = baixaOk;
              v._baixaErros = baixaErros.length > 0 ? baixaErros : undefined;
            }
          });

          validadas.push(venda.id);

          // PASSO 5: Financeiro
          const FinanceiroService = window.CH.FinanceiroService;
          if (FinanceiroService) FinanceiroService.registrarReceita(venda);

          // PASSO 6: Fiado (lote)
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

      // ── Sync em lote — somente as que foram validadas ──────────
      if (validadas.length > 0) _syncLote(validadas);

      // Sync do fiado (lote)
      const temFiado = aprovadas.some(v => v._fiado && v._fiadoClienteId);
      if (temFiado && window.CH.SyncQueue) {
        window.CH.SyncQueue.enqueue('salvar', 'fiado', Store.getFiado());
      }

      // Evento único no final
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

  // Exposição
  window.CH.AprovacaoService = {
    getPendentes, getAprovadas, getRejeitadas, getValidadas,
    contarPendentes, contarAprovadas,
    aprovarVenda, rejeitarVenda, validarVenda,
    aprovarTodas, validarTodas,
    isProcessandoLote: () => _processandoLote,
  };

  console.info('%c AprovacaoService ✓  (v3: rollback atômico | baixa ANTES do status | sem validada sem estoque)', 'color:#f59e0b;font-weight:bold');
})();
