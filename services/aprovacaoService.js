'use strict';
/**
 * services/aprovacaoService.js — CH Geladas PDV
 * Fluxo:  pendente → (controlador) → aprovada → (validador) → validada
 *
 * CORREÇÃO LOTE: aprovarTodas/validarTodas fazem mutação única + sync único
 * para evitar loop de re-render e race condition no SyncQueue.
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
        if (prod.controlaEstoque === false) continue; // produto sem controle de estoque (ex: cigarro)
        const pack  = prod.packs?.find(pk => pk.label === item.label || (pk.qtd + 'x') === item.label);
        const qtdUn = item.label === 'UNID' ? item.qtd : item.qtd * (pack?.qtd || 1);
        // Disponível = atual − reservas de OUTRAS vendas (excluindo a própria)
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

    // Libera a reserva de estoque para que outras vendas possam ser aprovadas
    window.CH.EstoqueService?.liberarReserva?.(vendaId);

    // Para vendas fiado pendentes: o saldo NUNCA foi atualizado (pela correção
    // do confirmarLancamento), então não há rollback de saldo necessário.
    // Apenas emitimos o evento específico para que fiado.html possa re-renderizar.
    if (venda._fiado && venda._fiadoClienteId) {
      EventBus.emit('fiado:lancamento:rejeitado', {
        vendaId,
        clienteId: venda._fiadoClienteId,
        valor:     venda.total,
        motivo,
        operador:  AuthService.getNome(),
      });
      console.info(`[AprovacaoService] Fiado rejeitado → cliente ${venda._fiadoClienteId} | motivo: ${motivo || 'sem motivo'}`);
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

    // 1. Marca validada primeiro (idempotente)
    Store.mutateVendas(list => {
      const v = list.find(v => v.id === vendaId);
      if (v) {
        v.status      = 'validada';
        v.validadaEm  = Utils.nowISO();
        v.validadaPor = AuthService.getNome();
      }
    });

    // Libera a reserva — a baixa real de estoque acontece logo abaixo
    window.CH.EstoqueService?.liberarReserva?.(vendaId);

    // Só sincroniza individualmente se NÃO estiver em lote
    if (!_processandoLote) _sync(vendaId);

    // 2. Baixa estoque
    const EstoqueService = window.CH.EstoqueService;
    if (EstoqueService) {
      for (const item of venda.itens || []) {
        try {
          const prod = EstoqueService.getProduto(item.prodId);
          if (!prod) continue;
          if (prod.controlaEstoque === false) continue; // produto sem controle de estoque (ex: cigarro)
          const pack = prod?.packs?.find(pk =>
            pk.label === item.label || (pk.qtd + 'x') === item.label
          );
          const qtdUn = item.label === 'UNID'
            ? item.qtd
            : item.qtd * (pack?.qtd || 1);
          await EstoqueService.baixarEstoqueVenda(item.prodId, qtdUn, venda.id);
        } catch (e) {
          console.warn(`[AprovacaoService] Estoque falhou "${item.nome}":`, e.message);
        }
      }
    } else {
      Store.mutateEstoque(estoque => {
        (venda.itens || []).forEach(item => {
          const prod = estoque.find(p => p.id === item.prodId);
          if (!prod) return;
          if (prod.controlaEstoque === false) return; // produto sem controle de estoque (ex: cigarro)
          const qtdDesc = item.label === 'UNID'
            ? item.qtd
            : item.qtd * (prod.packs?.find(pk => pk.label === item.label)?.qtd || 1);
          prod.qtdUn = Math.max(0, (prod.qtdUn || 0) - qtdDesc);
          prod.estoqueAtual = prod.qtdUn;
        });
      });
    }

    // FIX [CRÍTICO]: registrarReceita REMOVIDO daqui.
    // financeiroService.js tem hook EventBus.on('venda:finalizada', registrarReceita)
    // — chamada direta + evento causavam receita duplicada para cada venda validada.
    // O lote (validarTodas) chama diretamente pois emite venda:finalizada:lote, não venda:finalizada.

    // 3. Efetiva débito fiado (saldo + movimentacao) — SÓ AGORA, pós-validação.
    //    confirmarLancamento() em fiado.html NÃO atualiza c.saldo na criação;
    //    a atualização fica aqui para garantir que nenhum débito exista sem aprovação.
    if (venda._fiado && venda._fiadoClienteId) {
      const _ES_FS = window.CH?.Store;
      if (_ES_FS) {
        _ES_FS.mutateFiado(fiado => {
          const cx = fiado.find(x => x.id === venda._fiadoClienteId);
          if (!cx) return;
          cx.saldo = (cx.saldo || 0) + (venda.total || 0);
          if (!Array.isArray(cx.movimentacoes)) cx.movimentacoes = [];
          cx.movimentacoes.unshift({
            id:         Utils.generateId(),
            tipo:       'fiado',
            descricao:  venda._fiadoDesc || venda.itens?.[0]?.nome || 'Compra fiado',
            valor:      venda.total || 0,
            vendaId:    venda.id,
            validadoPor: AuthService.getNome(),
            criadoEm:   Utils.nowISO(),
          });
          if (cx.limite > 0 && cx.saldo >= cx.limite) cx.bloqueado = true;
        });
        if (window.CH.SyncQueue) {
          window.CH.SyncQueue.enqueue('salvar', 'fiado', Store.getFiado());
        }
        console.info(`[AprovacaoService] Fiado efetivado → cliente ${venda._fiadoClienteId} +R$${venda.total}`);
      }
    }

    // 4. Eventos — só emite se NÃO estiver em lote (evita N re-renders)
    if (!_processandoLote) {
      EventBus.emit('venda:finalizada', venda); // ← hook do financeiroService registra a receita aqui
      EventBus.emit('venda:validada', venda);
    }

    return true;
  }

  // ── APROVAR EM LOTE ───────────────────────────────────────────────
  // Uma única mutação, um único sync → zero loop de re-render
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
      // Mutação única — todos os status de uma vez
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

      // Sync único — todos juntos
      _syncLote(ids);

      // Evento único no final
      EventBus.emit('venda:aprovada:lote', { total: ids.length, operador });

    } catch (e) {
      erros.push({ erro: e.message });
    } finally {
      _processandoLote = false;
    }

    return { total: pendentes.length, erros };
  }

  // ── VALIDAR EM LOTE ───────────────────────────────────────────────
  // Mutação única para status, depois processa efeitos colaterais
  // sem disparar re-renders entre cada item
  async function validarTodas() {
    if (!_perm('aprovacao_validacao'))
      throw new Error('Sem permissão para validar vendas');

    const aprovadas = getAprovadas();
    if (!aprovadas.length) return { total: 0, erros: [] };

    const agora    = Utils.nowISO();
    const operador = AuthService.getNome();
    const ids      = aprovadas.map(v => v.id);
    const erros    = [];

    _processandoLote = true;
    try {
      // ── Passo 1: muda todos os status de uma vez (sem re-render) ──
      Store.mutateVendas(list => {
        ids.forEach(id => {
          const v = list.find(v => v.id === id);
          if (v && v.status === 'aprovada') {
            v.status      = 'validada';
            v.validadaEm  = agora;
            v.validadaPor = operador;
          }
        });
      });

      // ── Passo 2: sync único para todos ────────────────────────────
      _syncLote(ids);

      // ── Libera todas as reservas (baixas de estoque acontecem a seguir) ──
      const ES = window.CH.EstoqueService;
      if (ES?.liberarReserva) ids.forEach(id => ES.liberarReserva(id));

      // ── Passo 3: efeitos colaterais (estoque + financeiro) ─────────
      // Processa sem emitir store:updated a cada item
      for (const venda of aprovadas) {
        try {
          // Estoque
          const EstoqueService = window.CH.EstoqueService;
          if (EstoqueService) {
            for (const item of venda.itens || []) {
              try {
                const prod = EstoqueService.getProduto(item.prodId);
                if (!prod) continue;
                if (prod.controlaEstoque === false) continue; // produto sem controle de estoque (ex: cigarro)
                const pack = prod?.packs?.find(pk =>
                  pk.label === item.label || (pk.qtd + 'x') === item.label
                );
                const qtdUn = item.label === 'UNID'
                  ? item.qtd
                  : item.qtd * (pack?.qtd || 1);
                await EstoqueService.baixarEstoqueVenda(item.prodId, qtdUn, venda.id);
              } catch (e) {
                console.warn(`[Lote] Estoque falhou "${item.nome}":`, e.message);
              }
            }
          } else {
            Store.mutateEstoque(estoque => {
              (venda.itens || []).forEach(item => {
                const prod = estoque.find(p => p.id === item.prodId);
                if (!prod) return;
                if (prod.controlaEstoque === false) return; // produto sem controle de estoque (ex: cigarro)
                const qtdDesc = item.label === 'UNID'
                  ? item.qtd
                  : item.qtd * (prod.packs?.find(pk => pk.label === item.label)?.qtd || 1);
                prod.qtdUn = Math.max(0, (prod.qtdUn || 0) - qtdDesc);
                prod.estoqueAtual = prod.qtdUn;
              });
            });
          }

          // Financeiro
          const FinanceiroService = window.CH.FinanceiroService;
          if (FinanceiroService) FinanceiroService.registrarReceita(venda);

          // Efetiva débito fiado pós-validação (lote)
          // Mesmo critério do caminho individual: saldo só sobe aqui.
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

        } catch (e) {
          erros.push({ id: venda.id, erro: e.message });
        }
      }

      // Sync do fiado (lote) — uma única enfileirada para todos os clientes afetados
      const temFiado = aprovadas.some(v => v._fiado && v._fiadoClienteId);
      if (temFiado && window.CH.SyncQueue) {
        window.CH.SyncQueue.enqueue('salvar', 'fiado', Store.getFiado());
      }

      // ── Passo 4: evento único no final — UI re-renderiza UMA vez ──
      EventBus.emit('venda:validada:lote', { total: ids.length, operador });
      EventBus.emit('venda:finalizada:lote', aprovadas);

    } finally {
      _processandoLote = false;
    }

    return { total: aprovadas.length, erros };
  }

  // Exposição
  window.CH.AprovacaoService = {
    getPendentes, getAprovadas, getRejeitadas, getValidadas,
    contarPendentes, contarAprovadas,
    aprovarVenda, rejeitarVenda, validarVenda,
    aprovarTodas, validarTodas,
    isProcessandoLote: () => _processandoLote,
  };

  console.info('%c AprovacaoService ✓  (lote: mutação única | sem loop de re-render)', 'color:#f59e0b;font-weight:bold');
})();
