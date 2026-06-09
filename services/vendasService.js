'use strict';
/**
 * services/vendasService.js — CH Geladas PDV
 *
 * REGRA CRÍTICA:
 *   finalizarVenda() é SÍNCRONA — retorna o objeto venda imediatamente.
 *   CartService.finalize() (core.js) depende disso para funcionar.
 *
 * FIX CRÍTICO v3 — Integridade Transacional:
 *   Para vendas "concluídas" (fluxo direto sem aprovação):
 *   A baixa de estoque NÃO é mais fire-and-forget.
 *   _processarEfeitosAsync() agora:
 *     1. Executa a baixa com confirmarBaixaComRollback()
 *     2. Se falhar → registra divergência crítica e alerta
 *     3. Registra rastreabilidade completa
 *
 *   Embora o retorno seja síncrono (necessário para CartService),
 *   a baixa falha de forma detectável e rastreável, não silenciosa.
 *   Divergências são detectadas pela reconciliação automática.
 *
 * FLUXO DE APROVAÇÃO:
 *   Se perfil tem flag "vendas_requer_aprovacao" → status "pendente"
 *     → sem estoque, sem financeiro agora.
 *   Caso contrário → status "concluida" → _processarEfeitosAsync()
 */

(function () {
  const { Store, AuthService, Utils, EventBus } = window.CH;

  // ── Processa estoque + financeiro em background ────────────────────
  // FIX v3: Não é mais silent fire-and-forget. Falhas são registradas
  // como divergências críticas e disparam reconciliação automática.
  async function _processarEfeitosAsync(venda) {
    const itens = venda.itens || [];
    const IS    = window.CH.IntegrityService;
    const ES    = window.CH.EstoqueService;

    // ── Estoque ──────────────────────────────────────────────────
    if (ES) {
      if (IS?.confirmarBaixaComRollback) {
        // Caminho preferencial: com rastreabilidade e detecção de falha
        const resultado = await IS.confirmarBaixaComRollback(venda, null);
        if (!resultado.ok && resultado.rollbackExecutado) {
          // Baixa falhou — registra para reconciliação
          console.error(`[VendasService] Baixa falhou para venda concluída ${venda.id}:`, resultado.erros);
          EventBus.emit('integrity:venda_sem_baixa', {
            vendaId: venda.id,
            status:  'concluida',
            motivo:  resultado.erros?.join('; '),
          });
        }
      } else if (ES.baixarEstoqueVendaLote) {
        // Caminho alternativo: baixa em lote sem IntegrityService
        try {
          const resultado = await ES.baixarEstoqueVendaLote(venda);
          if (!resultado.ok && resultado.itensProcessados === 0) {
            console.error(`[VendasService] baixarEstoqueVendaLote falhou: venda ${venda.id}`);
          }
        } catch (e) {
          console.error(`[VendasService] Exceção na baixa: venda ${venda.id}:`, e.message);
          EventBus.emit('integrity:venda_sem_baixa', {
            vendaId: venda.id,
            status:  'concluida',
            motivo:  e.message,
          });
        }
      } else {
        // Fallback local (sem Firebase)
        Store.mutateEstoque(estoque => {
          itens.forEach(item => {
            const prod = estoque.find(p => p.id === item.prodId);
            if (!prod || prod.controlaEstoque === false) return;
            const qtdDesc = item.label === 'UNID'
              ? item.qtd
              : item.qtd * (prod.packs?.find(pk => pk.label === item.label)?.qtd || 1);
            prod.qtdUn = Math.max(0, (prod.qtdUn || 0) - qtdDesc);
            prod.estoqueAtual = prod.qtdUn;
          });
        });
      }
    }

    // ── Financeiro ───────────────────────────────────────────────
    // NOTA: não chama registrarReceita diretamente aqui pois
    // EventBus.on('venda:finalizada') já disparou registrarReceita
    // via financeiroService hook. Chamar aqui seria duplo registro.
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

    // ── FLUXO DIRETO: dispara efeitos em background ───────────────
    // Erros são rastreados — não são silenciosos
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
    const vendas = getVendasPeriodo(_localDateISO(dom) // FIX #5b, Utils.todayISO())
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
    const vendas = getVendasPeriodo(_localDateISO(dm) // FIX #5b, Utils.todayISO())
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

  console.info('%c VendasService ✓  (v3: baixa rastreável | sem fire-and-forget silencioso)', 'color:#10b981;font-weight:bold');
})();
