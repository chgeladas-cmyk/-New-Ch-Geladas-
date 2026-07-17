'use strict';
/**
 * services/vendasService.js — CH Geladas PDV
 *
 * REGRA CRÍTICA:
 *   finalizarVenda() é SÍNCRONA — retorna o objeto venda imediatamente.
 *   CartService.finalize() (core.js) depende disso para funcionar.
 *
 * FIX v4 — Baixa de Estoque por Unidade e Fardo:
 *   IntegrityService é um stub vazio (removido). O código anterior caía
 *   em IS?.confirmarBaixaComRollback que nunca existia → baixa nunca executava.
 *   Agora _processarEfeitosAsync vai direto para EstoqueService.baixarEstoqueVendaLote,
 *   que já sabe resolver UNID (1 unidade) e qualquer Pack/Fardo (qtd × pack.qtd).
 *
 * FLUXO DE APROVAÇÃO:
 *   Se perfil tem flag "vendas_requer_aprovacao" → status "pendente"
 *     → sem estoque, sem financeiro agora.
 *   Caso contrário → status "concluida" → _processarEfeitosAsync()
 */

(function () {
  const { Store, AuthService, Utils, EventBus } = window.CH;

  // ── Fallback local de emergência — resolve UNID e Fardo corretamente ──
  function _baixarEstoqueLocal(itens) {
    Store.mutateEstoque(estoque => {
      itens.forEach(item => {
        const prod = estoque.find(p => p.id === item.prodId);
        if (!prod || prod.controlaEstoque === false) return;
        const pack    = (prod.packs || []).find(pk =>
          pk.label === item.label || (pk.qtd + 'x') === item.label
        );
        const qtdDesc = item.label === 'UNID'
          ? item.qtd
          : item.qtd * (pack?.qtd || 1);
        prod.qtdUn        = Math.max(0, (prod.qtdUn || 0) - qtdDesc);
        prod.estoqueAtual = prod.qtdUn;
      });
    });
  }

  // ── Processa estoque em background ────────────────────────────────────
  // FIX v4: IntegrityService é stub vazio — não usar confirmarBaixaComRollback.
  // Vai direto para EstoqueService.baixarEstoqueVendaLote que suporta UNID e Fardo.
  async function _processarEfeitosAsync(venda) {
    const ES = window.CH.EstoqueService;

    if (!ES) {
      // Sem EstoqueService: fallback local
      _baixarEstoqueLocal(venda.itens || []);
      return;
    }

    if (ES.baixarEstoqueVendaLote) {
      try {
        const resultado = await ES.baixarEstoqueVendaLote(venda);
        if (!resultado.ok && resultado.itensProcessados === 0 && !resultado.localFallback) {
          console.error(`[VendasService] baixarEstoqueVendaLote falhou: venda ${venda.id}`, resultado.erros);
          EventBus.emit('integrity:venda_sem_baixa', {
            vendaId: venda.id,
            status:  'concluida',
            motivo:  (resultado.erros || []).join('; '),
          });
        }
      } catch (e) {
        console.error(`[VendasService] Exceção na baixa: venda ${venda.id}:`, e.message);
        // Garante baixa mesmo com exceção
        _baixarEstoqueLocal(venda.itens || []);
        EventBus.emit('integrity:venda_sem_baixa', {
          vendaId: venda.id,
          status:  'concluida',
          motivo:  e.message,
        });
      }
    } else {
      // EstoqueService existe mas sem baixarEstoqueVendaLote
      _baixarEstoqueLocal(venda.itens || []);
    }

    // ── Financeiro ───────────────────────────────────────────────
    // financeiroService registra receita via EventBus.on('venda:finalizada')
    // Não registrar aqui para evitar duplicação.
  }

  // ══════════════════════════════════════════════════════════════════
  //  FINALIZAR VENDA — SÍNCRONO (não async!)
  // ══════════════════════════════════════════════════════════════════
  function finalizarVenda(cart, formaPgto, extras = {}) {
    const itens    = cart.getItems    ? cart.getItems()    : (cart.itens    || []);
    const total    = cart.getTotal    ? cart.getTotal()    : (cart.total    || 0);
    const subtotal = cart.getSubtotal ? cart.getSubtotal() : (cart.subtotal || total);
    const desconto = cart.getDesconto ? cart.getDesconto() : (cart.desconto || 0);

    if (!itens.length) throw new Error('Carrinho vazio');

    const lucro = itens.reduce((s, i) => s + (i.preco - (i.custo || 0)) * i.qtd, 0) - desconto;
    const role  = AuthService.getRole();

    const _Perm = window.CH.PermissoesService;
    const _rolesLivres = ['adm', 'admin', 'gerente', 'operador', 'pdv', 'entregador'];
    let requerAprovacao;
    if (_Perm) {
      requerAprovacao = _Perm.getFlag(role, 'vendas_requer_aprovacao');
    } else {
      requerAprovacao = !_rolesLivres.includes(role);
      console.warn('[VendasService] PermissoesService não carregado — usando fallback conservador para role:', role);
    }

    const venda = {
      id:               Utils.generateId(),
      dataCurta:        Utils.todayISO(),
      data:             Utils.today(),
      hora:             Utils.nowTime(),
      criadoEm:         Utils.nowISO(),
      itens, total, subtotal, desconto, lucro,
      formaPgto:        formaPgto || 'Dinheiro',
      origem:           'PDV',
      operador:         AuthService.getNome(),
      role,
      status:           requerAprovacao ? 'pendente' : 'concluida',
      _fbSynced:        false,
      _troco:           extras.troco           || 0,
      _parcelaDinheiro: extras.parcelaDinheiro || 0,
      _parcelaRestante: extras.parcelaRestante || 0,
      _formaRestante:   extras.formaRestante   || '',
    };

    // 1. Salva no Store
    Store.mutateVendas(v => { v.unshift(venda); });

    // 2. Sync Firebase
    if (window.CH.SyncQueue) {
      window.CH.SyncQueue.enqueue('salvar', 'vendas', [venda]);
    }

    // 3. Limpa carrinho imediatamente
    if (cart.clear) cart.clear();

    // ── REQUER APROVAÇÃO: para aqui, sem estoque/financeiro ──────
    if (requerAprovacao) {
      const ES = window.CH.EstoqueService;
      if (ES?.reservarEstoque) {
        try { ES.reservarEstoque(venda.id, venda.itens || []); }
        catch(e) { console.warn('[VendasService] Reserva de estoque falhou:', e.message); }
      }
      EventBus.emit('venda:pendente', venda);
      console.info(`[VendasService] Venda PENDENTE (${role}) → ${venda.id}`);
      return venda;
    }

    // ── FLUXO DIRETO: dispara baixa de estoque em background ─────
    _processarEfeitosAsync(venda).catch(e =>
      console.error('[VendasService] Erro em _processarEfeitosAsync:', e)
    );

    EventBus.emit('venda:finalizada', venda);
    return venda;
  }

  // ══════════════════════════════════════════════════════════════════
  //  CANCELAR VENDA
  // ══════════════════════════════════════════════════════════════════
  async function cancelarVenda(vendaId) {
    const venda = Store.getVendas().find(v => v.id === vendaId);
    if (!venda)                       throw new Error(`Venda ${vendaId} não encontrada`);
    if (venda.status === 'cancelada') throw new Error('Venda já cancelada');
    if (venda.status === 'pendente')  throw new Error('Use "rejeitar" no painel de aprovação');
    if (venda.status === 'rejeitada') throw new Error('Venda já foi rejeitada');

    if (['concluida', 'validada'].includes(venda.status)) {
      const EstoqueService = window.CH.EstoqueService;
      if (EstoqueService) await EstoqueService.cancelarVenda(vendaId, venda.itens || []);

      // BUG CORRIGIDO: cancelar uma venda fiado já validada restaurava o
      // estoque mas nunca revertia o débito no saldo do cliente — ele
      // continuava devendo por uma venda que não existe mais. Delegado
      // pro AprovacaoService, que já tem a lógica simétrica de aplicar
      // esse débito (ver Passo 5 de validarVenda).
      if (venda._fiado && venda._fiadoClienteId) {
        window.CH.AprovacaoService?.reverterFiadoPorCancelamento?.(venda);
      }
    }

    Store.mutateVendas(vendas => {
      const v = vendas.find(v => v.id === vendaId);
      if (v) {
        v.status       = 'cancelada';
        v.canceladaEm  = Utils.nowISO();
        v.canceladaPor = AuthService.getNome();
      }
    });

    // FIX #1: Duplo estorno removido.
    // O estorno era chamado aqui (direto) E via EventBus.on('venda:cancelada').
    // Agora apenas o EventBus dispara registrarEstorno (ver financeiroService.js).

    // Desbloqueia venda se estava bloqueada por integridade
    window.CH.IntegrityService?.desbloquearVenda?.(vendaId);

    if (window.CH.SyncQueue) {
      const v = Store.getVendas().find(v => v.id === vendaId);
      if (v) window.CH.SyncQueue.enqueue('atualizar', 'vendas', [v]);
    }

    EventBus.emit('venda:cancelada', { vendaId, operador: AuthService.getNome() });
    return true;
  }

  // ══════════════════════════════════════════════════════════════════
  //  CONSULTAS
  // ══════════════════════════════════════════════════════════════════
  function getVendasPeriodo(dataDe, dataAte) {
    return Store.getVendas().filter(v => v.dataCurta >= dataDe && v.dataCurta <= dataAte);
  }

  function getVendasHoje() {
    return getVendasPeriodo(Utils.todayISO(), Utils.todayISO());
  }

  function getResumoHoje() {
    const todas  = getVendasHoje();
    const vendas = todas.filter(v => ['concluida', 'validada'].includes(v.status));
    const total  = vendas.reduce((s, v) => s + (v.total || 0), 0);
    const lucro  = vendas.reduce((s, v) => s + (v.lucro || 0), 0);
    const qtdItens = vendas.reduce((s, v) =>
      s + (v.itens?.reduce((si, i) => si + i.qtd, 0) || 0), 0);
    const porForma = {};
    vendas.forEach(v => {
      const f = v.formaPgto || 'Outros';
      porForma[f] = (porForma[f] || 0) + v.total;
    });
    return {
      quantidade: vendas.length, total, lucro, qtdItens,
      ticketMedio: vendas.length ? total / vendas.length : 0,
      porForma,
      pendentes: todas.filter(v => v.status === 'pendente').length,
      aprovadas: todas.filter(v => v.status === 'aprovada').length,
    };
  }

  function getResumoSemana() {
    const hoje = new Date(), dom = new Date(hoje);
    dom.setDate(hoje.getDate() - hoje.getDay());
    const ini = dom.toISOString().slice(0, 10);
    const vendas = getVendasPeriodo(ini, Utils.todayISO())
      .filter(v => ['concluida', 'validada'].includes(v.status));
    return {
      quantidade: vendas.length,
      total:      vendas.reduce((s, v) => s + v.total, 0),
      lucro:      vendas.reduce((s, v) => s + (v.lucro || 0), 0),
    };
  }

  function getProdutosMaisVendidos(limite = 10, periodo = 30) {
    const dm = new Date();
    dm.setDate(dm.getDate() - periodo);
    const ini = dm.toISOString().slice(0, 10);
    const vendas = getVendasPeriodo(ini, Utils.todayISO())
      .filter(v => ['concluida', 'validada'].includes(v.status));
    const mapa = {};
    vendas.forEach(venda => {
      venda.itens?.forEach(item => {
        if (!mapa[item.prodId]) {
          mapa[item.prodId] = { prodId: item.prodId, nome: item.nome, qtd: 0, total: 0 };
        }
        mapa[item.prodId].qtd   += item.qtd;
        mapa[item.prodId].total += item.preco * item.qtd;
      });
    });
    return Object.values(mapa).sort((a, b) => b.qtd - a.qtd).slice(0, limite);
  }

  window.CH.VendasService = {
    finalizarVenda,
    cancelarVenda,
    getVendasPeriodo,
    getVendasHoje,
    getResumoHoje,
    getResumoSemana,
    getProdutosMaisVendidos,
  };

  console.info('%c VendasService ✓  (v4: baixa direta via EstoqueService | UNID + Fardo/Pack)', 'color:#10b981;font-weight:bold');
})();
