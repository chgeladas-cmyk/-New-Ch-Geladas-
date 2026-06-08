'use strict';
/**
 * services/estoqueService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Camada de domínio para estoque.
 *
 * PROBLEMA RESOLVIDO (sobrescrita concorrente):
 *   Antes: Aparelho A e B salvavam o array inteiro de estoque.
 *          O último a salvar sobrescrevia o outro → estoque errado.
 *   Agora: Cada baixa/entrada usa Firebase Transaction no documento
 *          do produto → lê o valor atual, valida, subtrai, salva.
 *          Impossível sobrescrever. Race condition eliminado.
 *
 * Modelos:
 *
 *   Produto (em estoque[]):
 *     id, nome, categoria, precoVenda (= precoUn), precoCusto (= custoUn),
 *     estoqueAtual (= qtdUn), estoqueMinimo, ativo, fornecedorId, unidade,
 *     packs, updatedAt, createdAt
 *
 *   Movimentação (em movimentacoes[]):
 *     id, produtoId, nomeProduto, tipo, quantidade,
 *     estoqueAntes, estoqueDepois, origem, operador,
 *     observacao, custo, fornecedorId, timestamp
 *
 *   Categoria (em categorias[]):
 *     id, nome, cor
 *
 *   Fornecedor (em fornecedores[]):
 *     id, nome, telefone, email, cnpj, observacao, ativo
 *
 * Requer: core.js + services/auditService.js carregados antes.
 */

(function () {
  const { Store, AuthService, Utils, EventBus, FirebaseService } = window.CH;

  // ── Helpers internos ─────────────────────────────────────────────
  function _usuario()   { return AuthService.getNome(); }
  function _isOnline()  { return navigator.onLine; }

  // ══════════════════════════════════════════════════════════════════
  //  RESERVA DE ESTOQUE — Previne o "Paradoxo do Estoque"
  //
  //  Quando uma venda vai para status "pendente" o estoque físico
  //  ainda não é baixado. Sem reserva, dois colaboradores poderiam
  //  vender o mesmo item até o limite total, causando furo no
  //  inventário ao validar. A reserva soft-bloqueia as unidades
  //  enquanto a venda aguarda aprovação/validação.
  //
  //  Estrutura em localStorage (CH_RESERVAS_ESTOQUE):
  //    { [vendaId]: { [prodId]: qtdUnidadesReservadas, ... }, ... }
  // ══════════════════════════════════════════════════════════════════

  const _RESERVAS_KEY = 'CH_RESERVAS_ESTOQUE';

  function _getReservas() {
    try { return JSON.parse(localStorage.getItem(_RESERVAS_KEY) || '{}'); } catch { return {}; }
  }

  function _setReservas(r) {
    try { localStorage.setItem(_RESERVAS_KEY, JSON.stringify(r)); } catch(_) {}
  }

  /**
   * Reserva unidades de estoque para uma venda pendente.
   * Deve ser chamado quando a venda entra em status "pendente".
   * É idempotente: sobrescreve a reserva anterior para o mesmo vendaId.
   */
  function reservarEstoque(vendaId, itens) {
    if (!vendaId || !itens?.length) return;
    const reservas = _getReservas();
    reservas[vendaId] = {};
    for (const item of itens) {
      const prod = getProduto(item.prodId);
      if (!prod) continue;
      if (prod.controlaEstoque === false) continue; // produto sem controle de estoque (ex: cigarro)
      const pack  = prod.packs?.find(pk => pk.label === item.label || (pk.qtd + 'x') === item.label);
      const qtdUn = item.label === 'UNID' ? item.qtd : item.qtd * (pack?.qtd || 1);
      reservas[vendaId][item.prodId] = (reservas[vendaId][item.prodId] || 0) + qtdUn;
    }
    _setReservas(reservas);
    EventBus.emit('estoque:reserva_atualizada', { vendaId });
    console.info(`[EstoqueService] Reserva criada para venda ${vendaId}:`, reservas[vendaId]);
  }

  /**
   * Libera a reserva de uma venda (rejeição ou validação efetiva).
   * Após chamar este método, as unidades voltam ao estoque disponível.
   */
  function liberarReserva(vendaId) {
    if (!vendaId) return;
    const reservas = _getReservas();
    if (!reservas[vendaId]) return; // já liberada
    delete reservas[vendaId];
    _setReservas(reservas);
    EventBus.emit('estoque:reserva_atualizada', { vendaId });
    console.info(`[EstoqueService] Reserva liberada para venda ${vendaId}`);
  }

  /**
   * Retorna o total de unidades reservadas para um produto
   * (soma de todas as vendas pendentes que o incluem).
   */
  function getQtdReservada(prodId) {
    const reservas = _getReservas();
    return Object.values(reservas).reduce((s, r) => s + (r[prodId] || 0), 0);
  }

  /**
   * Retorna o estoque disponível descontando reservas de vendas pendentes.
   * Use este valor no PDV e na tela de aprovação para exibir quantidade real.
   */
  function getEstoqueDisponivel(prodId) {
    const prod = getProduto(prodId);
    if (!prod) return 0;
    const atual     = prod.estoqueAtual ?? prod.qtdUn ?? 0;
    const reservado = getQtdReservada(prodId);
    return Math.max(0, atual - reservado);
  }

  /** Retorna o mapa completo de reservas (para diagnóstico). */
  function getReservas() { return _getReservas(); }

  // Alias de campos legados → modelo novo (retrocompat)
  function _normalizarProduto(p) {
    const estoqueAtual  = p.estoqueAtual ?? p.qtdUn ?? 0;
    const qtdReservada  = getQtdReservada(p.id);
    return {
      ...p,
      precoVenda:         p.precoVenda  ?? p.precoUn  ?? 0,
      precoCusto:         p.precoCusto  ?? p.custoUn  ?? 0,
      estoqueAtual,
      estoqueMinimo:      p.estoqueMinimo ?? 0,
      qtdUn:              p.qtdUn       ?? estoqueAtual,       // compat
      precoUn:            p.precoUn     ?? p.precoVenda ?? 0,  // compat
      custoUn:            p.custoUn     ?? p.precoCusto ?? 0,  // compat
      ativo:              p.ativo       ?? true,
      unidade:            p.unidade     ?? 'UN',
      // ── Reserva de estoque ────────────────────────────────────
      qtdReservada,
      estoqueDisponivel:  Math.max(0, estoqueAtual - qtdReservada),
    };
  }

  // ════════════════════════════════════════════════════════════════
  //  PRODUTOS
  // ════════════════════════════════════════════════════════════════

  /** Retorna todos os produtos normalizados */
  function getProdutos() {
    return Store.getEstoque().map(_normalizarProduto);
  }

  /** Retorna um produto pelo id */
  function getProduto(id) {
    const p = Store.getEstoque().find(p => p.id === id);
    return p ? _normalizarProduto(p) : null;
  }

  /** Cria um novo produto */
  function adicionarProduto(dados) {
    const antes = null;
    const prod = {
      id:           Utils.generateId(),
      nome:         dados.nome?.trim() || 'Produto sem nome',
      categoria:    dados.categoria    || '',
      precoVenda:   Number(dados.precoVenda  || dados.precoUn  || 0),
      precoCusto:   Number(dados.precoCusto  || dados.custoUn  || 0),
      estoqueAtual: Number(dados.estoqueAtual || dados.qtdUn   || 0),
      estoqueMinimo:Number(dados.estoqueMinimo || 0),
      qtdUn:        Number(dados.qtdUn       || dados.estoqueAtual || 0),
      precoUn:      Number(dados.precoUn     || dados.precoVenda   || 0),
      custoUn:      Number(dados.custoUn     || dados.precoCusto   || 0),
      ativo:           dados.ativo ?? true,
      controlaEstoque: dados.controlaEstoque ?? true,
      unidade:         dados.unidade || 'UN',
      fornecedorId:    dados.fornecedorId || null,
      packs:           dados.packs || [],
      createdAt:    Utils.nowISO(),
      updatedAt:    Utils.nowISO(),
    };

    Store.mutateEstoque(estoque => { estoque.push(prod); });

    window.CH.AuditService?.auditarEstoque('criar', null, prod);
    EventBus.emit('estoque:adicionado', prod);
    return prod;
  }

  /** Atualiza campos de um produto existente */
  function atualizarProduto(id, campos) {
    let antes = null, depois = null;

    Store.mutateEstoque(estoque => {
      const idx = estoque.findIndex(p => p.id === id);
      if (idx < 0) return;
      antes = { ...estoque[idx] };

      // Sincroniza aliases antes/depois da atualização
      if ('precoVenda'   in campos) campos.precoUn   = campos.precoVenda;
      if ('precoCusto'   in campos) campos.custoUn   = campos.precoCusto;
      if ('estoqueAtual' in campos) campos.qtdUn     = campos.estoqueAtual;
      if ('precoUn'      in campos) campos.precoVenda = campos.precoUn;
      if ('custoUn'      in campos) campos.precoCusto = campos.custoUn;
      if ('qtdUn'        in campos) campos.estoqueAtual = campos.qtdUn;

      Object.assign(estoque[idx], campos, { updatedAt: Utils.nowISO() });
      depois = { ...estoque[idx] };
    });

    if (!antes) { console.warn('[Estoque] atualizarProduto: id não encontrado', id); return null; }

    window.CH.AuditService?.auditarEstoque('editar', antes, depois);
    EventBus.emit('estoque:atualizado', depois);
    return depois;
  }

  /** Desativa um produto (soft delete) */
  function removerProduto(id) {
    const prod = getProduto(id);
    if (!prod) return false;
    atualizarProduto(id, { ativo: false });
    window.CH.AuditService?.auditarEstoque('deletar', prod, { ...prod, ativo: false });
    EventBus.emit('estoque:removido', prod);
    return true;
  }

  // ════════════════════════════════════════════════════════════════
  //  MOVIMENTAÇÕES — CORAÇÃO DO CONTROLE DE ESTOQUE
  // ════════════════════════════════════════════════════════════════

  /**
   * Registra uma movimentação com Firebase Transaction.
   * A transação garante que nunca haverá sobrescrita concorrente:
   *   - Lê o valor atual do documento no Firestore
   *   - Valida (não deixa ficar negativo em venda)
   *   - Subtrai/soma atomicamente
   *   - Registra a movimentação
   *
   * Se offline, cai para modo local com enfileiramento.
   */
  async function _registrarMovimentacao({
    produtoId,
    tipo,        // 'entrada' | 'venda' | 'avaria' | 'ajuste' | 'transferencia' | 'cancelamento'
    quantidade,  // número positivo (a lógica de sinal é interna)
    origem       = 'manual',
    operador     = null,
    observacao   = '',
    custo        = null,
    fornecedorId = null,
    _forceDelta  = null, // quando passado, ignora a lógica de sinal e usa o delta direto
  }) {
    const prod = getProduto(produtoId);
    if (!prod) throw new Error(`Produto ${produtoId} não encontrado`);

    const estoqueAntes = prod.estoqueAtual ?? prod.qtdUn ?? 0;

    // _forceDelta permite ajuste bidirecional (positivo ou negativo)
    // Quando não passado, calcula pelo tipo: saídas subtraem, entradas somam
    let delta;
    if (_forceDelta !== null) {
      delta = _forceDelta; // já tem sinal correto (+/-)
    } else {
      const eSaida = ['venda','avaria','transferencia'].includes(tipo);
      delta = eSaida ? -Math.abs(quantidade) : Math.abs(quantidade);
    }

    const estoqueDepois = Math.max(0, estoqueAntes + delta);
    const eSaida = delta < 0; // recalcula para validação de estoque insuficiente

    // ── Tenta usar Firebase Transaction (modo online + admin) ──────────
    // PDV não tem adminToken → Firestore rejeitaria a escrita de qualquer forma.
    // Nesse caso, aplica localmente e SyncQueue envia quando admin sincronizar.
    // FIX [CRÍTICO]: adminToken obrigatório para escrever ch_dados/estoque nas
    // Firestore Rules. Sem ele, a Transaction lança permission-denied silencioso,
    // cai no fallback local e o onSnapshot subsequente sobrescreve a alteração.
    // Solução: só tenta Transaction quando tem token; caso contrário vai direto
    // ao modo local + SyncQueue (admin processa na próxima sessão com token).
    const _tok = FirebaseService.getAdminToken?.();

    if (_isOnline() && FirebaseService.isReady() && _tok) {
      // ── Retry automático: até MAX_RETRY tentativas com backoff ──────
      const MAX_RETRY  = 3;
      const DELAY_BASE = 800; // ms
      let tentativa    = 0;
      let sucesso      = false;
      let ultimoErro   = null;

      while (tentativa < MAX_RETRY && !sucesso) {
        if (tentativa > 0) {
          const delay = DELAY_BASE * tentativa;
          console.warn(`[Estoque] Retry ${tentativa}/${MAX_RETRY - 1} para "${prod.nome}" em ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        }
        tentativa++;

        try {
          let qtdGravada = null;

          await FirebaseService.runTransaction(async (tx) => {
            const estoqueRef = FirebaseService.docRef('ch_dados', 'estoque');
            const snap       = await tx.get(estoqueRef);
            const dadosFB    = snap.exists() ? (snap.data().dados || []) : [];

            const prodFB     = dadosFB.find(p => p.id === produtoId);
            const qtdAtualFB = prodFB ? (prodFB.qtdUn ?? prodFB.estoqueAtual ?? 0) : estoqueAntes;

            if (eSaida && qtdAtualFB < Math.abs(delta)) {
              throw new Error(
                `Estoque insuficiente para "${prod.nome}": ` +
                `disponível ${qtdAtualFB}, solicitado ${Math.abs(delta)}`
              );
            }

            const novaQtd = Math.max(0, qtdAtualFB + delta);
            qtdGravada    = novaQtd;

            const novosDados = dadosFB.map(p =>
              p.id === produtoId
                ? { ...p, qtdUn: novaQtd, estoqueAtual: novaQtd, updatedAt: Utils.nowISO() }
                : p
            );
            if (!prodFB) novosDados.push({ ...prod, qtdUn: novaQtd, estoqueAtual: novaQtd });

            tx.set(estoqueRef, {
              dados:      novosDados,
              ts:         Utils.nowISO(),
              adminToken: _tok,
            });

            // FIX: adminToken em movimentacoes — Firestore Rules exigem em ambos os docs
            const movRef = FirebaseService.newDocRef('movimentacoes');
            tx.set(movRef, {
              id:            movRef.id,
              produtoId,
              nomeProduto:   prod.nome,
              tipo,
              quantidade:    delta,
              estoqueAntes:  qtdAtualFB,
              estoqueDepois: novaQtd,
              origem,
              operador:      operador || _usuario(),
              observacao,
              custo:         custo ?? prod.precoCusto ?? 0,
              fornecedorId,
              timestamp:     Utils.nowISO(),
              dataCurta:     Utils.todayISO(),
              adminToken:    _tok,
            });
          });

          // ── Verificação pós-escrita ─────────────────────────────────
          try {
            const estoqueRef = FirebaseService.docRef('ch_dados', 'estoque');
            const snapV      = await FirebaseService.getDoc(estoqueRef);
            const dadosV     = snapV.exists() ? (snapV.data().dados || []) : [];
            const prodV      = dadosV.find(p => p.id === produtoId);
            const qtdV       = prodV ? (prodV.qtdUn ?? prodV.estoqueAtual) : null;

            if (qtdV === null) {
              console.warn(`[Estoque] ⚠ Verificação: produto ${produtoId} não encontrado após transação`);
            } else if (Math.abs(qtdV - qtdGravada) > 0.001) {
              console.error(`[Estoque] ✗ Verificação FALHOU: esperado ${qtdGravada}, FB tem ${qtdV} para "${prod.nome}"`);
              _registrarFalha({ produtoId, nomeProduto: prod.nome, tipo, origem,
                esperado: qtdGravada, encontrado: qtdV, tentativas: tentativa });
            } else {
              console.info(`[Estoque] ✓ Verificado: ${prod.nome} = ${qtdV} (tentativa ${tentativa})`);
            }
          } catch (eV) {
            console.warn('[Estoque] Verificação pós-escrita falhou (non-fatal):', eV.message);
          }

          Store.mutateEstoque(estoque => {
            const p = estoque.find(p => p.id === produtoId);
            if (p) { p.qtdUn = estoqueDepois; p.estoqueAtual = estoqueDepois; p.updatedAt = Utils.nowISO(); }
          });

          sucesso = true;
          console.info(`[Estoque] ✓ Transação ${tipo}: ${prod.nome} (${estoqueAntes}→${estoqueDepois})`);

        } catch (e) {
          if (e.message?.includes('insuficiente')) throw e;
          ultimoErro = e;
          console.warn(`[Estoque] Tentativa ${tentativa} falhou: ${e.message}`);
        }
      } // fim retry

      if (!sucesso) {
        console.error(`[Estoque] ✗ Todas as ${MAX_RETRY} tentativas falharam para "${prod.nome}": ${ultimoErro?.message}`);
        _registrarFalha({ produtoId, nomeProduto: prod.nome, tipo, origem,
          erro: ultimoErro?.message, tentativas: MAX_RETRY, definitivo: true });
        _movimentacaoLocal({ produtoId, prod, tipo, delta, estoqueAntes, estoqueDepois, origem, operador, observacao, custo, fornecedorId });
      }

    } else {
      const motivo = !_isOnline() ? 'offline' : !FirebaseService.isReady() ? 'Firebase não pronto' : 'sem adminToken';
      console.info(`[Estoque] Modo local (${motivo}): ${tipo} ${prod.nome}`);
      _movimentacaoLocal({ produtoId, prod, tipo, delta, estoqueAntes, estoqueDepois, origem, operador, observacao, custo, fornecedorId });
      if (origem && origem.startsWith('venda:')) _agendarReconciliacao(origem);
    }

    const mov = {
      id:            Utils.generateId(),
      produtoId,
      nomeProduto:   prod.nome,
      tipo,
      quantidade:    delta,
      estoqueAntes,
      estoqueDepois,
      origem,
      operador:      operador || _usuario(),
      observacao,
      custo:         custo ?? prod.precoCusto ?? 0,
      fornecedorId,
      timestamp:     Utils.nowISO(),
      dataCurta:     Utils.todayISO(),
    };

    // Persiste movimentação no Store local
    Store.mutateMovimentacoes(movs => { movs.unshift(mov); });

    window.CH.AuditService?.auditarMovimentacao(mov);
    EventBus.emit('estoque:movimentado', mov);
    return mov;
  }

  /** Aplica movimentação apenas no Store local (offline/fallback) */
  function _movimentacaoLocal({ produtoId, delta, estoqueDepois, origem }) {
    Store.mutateEstoque(estoque => {
      const p = estoque.find(p => p.id === produtoId);
      if (p) {
        p.qtdUn        = estoqueDepois;
        p.estoqueAtual = estoqueDepois;
        p.updatedAt    = Utils.nowISO();
      }
    });
    console.info(`[Estoque] Movimentação local (offline): ${origem}`);
  }

  // ── APIs de alto nível ───────────────────────────────────────────

  /** Entrada de mercadoria (compra de fornecedor) */
  async function entradaEstoque(produtoId, quantidade, { custo, fornecedorId, observacao } = {}) {
    return _registrarMovimentacao({
      produtoId, tipo: 'entrada', quantidade,
      origem: 'compra', custo, fornecedorId, observacao,
    });
  }

  /**
   * Baixa de estoque por venda — com Firebase Transaction.
   * FIX [CRÍTICO]: Idempotente — uma segunda chamada com o mesmo vendaId
   * não baixa o estoque de novo. Protege contra retry do SyncQueue e
   * reprocessamento em validarTodas() se interrompida no meio do lote.
   */
  async function baixarEstoqueVenda(produtoId, quantidade, vendaId) {
    // Verifica se essa venda já gerou movimentação de saída para este produto
    if (vendaId) {
      const origemKey = `venda:${vendaId}`;
      const jaProcessado = Store.getMovimentacoes().some(
        m => m.origem === origemKey && m.produtoId === produtoId && m.tipo === 'venda'
      );
      if (jaProcessado) {
        console.info(`[EstoqueService] baixarEstoqueVenda ignorado — venda ${vendaId} já processada para produto ${produtoId}`);
        return null; // idempotente: não baixa de novo
      }
    }
    return _registrarMovimentacao({
      produtoId, tipo: 'venda', quantidade,
      origem: `venda:${vendaId}`,
    });
  }

  /**
   * BAIXA TODOS OS ITENS DE UMA VENDA EM UMA ÚNICA TRANSACTION.
   * Resolve o bug de múltiplos itens:
   *  - 1 leitura + 1 escrita em ch_dados/estoque (sem contention)
   *  - Sem SyncQueue intermediário entre itens (sem race condition)
   *  - Idempotente: pula produtos já processados para esta venda
   *
   * @param {object} venda  - objeto completo da venda
   * @returns {{ ok: boolean, itensProcessados: number, erros: string[] }}
   */
  async function baixarEstoqueVendaLote(venda) {
    if (!venda?.itens?.length) return { ok: true, itensProcessados: 0, erros: [] };

    const _tok = FirebaseService.getAdminToken?.();

    // ── Monta lista de itens que precisam de baixa ──────────────────
    const itensParaBaixar = [];
    for (const item of venda.itens) {
      const prod = getProduto(item.prodId);
      if (!prod)                          continue; // produto não encontrado
      if (prod.controlaEstoque === false) continue; // cigarro, sem controle

      // Idempotência: verifica se já foi processado localmente
      const origemKey   = `venda:${venda.id}`;
      const jaProcessado = Store.getMovimentacoes().some(
        m => m.origem === origemKey && m.produtoId === item.prodId && m.tipo === 'venda'
      );
      if (jaProcessado) continue;

      const pack = prod.packs?.find(pk =>
        pk.label === item.label || (pk.qtd + 'x') === item.label
      );
      const qtdUn = item.label === 'UNID'
        ? item.qtd
        : item.qtd * (pack?.qtd || 1);

      itensParaBaixar.push({ item, prod, qtdUn, origemKey });
    }

    if (itensParaBaixar.length === 0) {
      console.info(`[Estoque] Lote venda ${venda.id}: todos os itens já processados ou sem controle.`);
      return { ok: true, itensProcessados: 0, erros: [] };
    }

    const erros    = [];
    const MAX_RETRY = 3;

    // ── Modo Firebase: UMA transaction para todos os itens ──────────
    if (_isOnline() && FirebaseService.isReady() && _tok) {
      let sucesso   = false;
      let ultimoErr = null;
      let resultados = [];

      for (let tentativa = 1; tentativa <= MAX_RETRY; tentativa++) {
        if (tentativa > 1) {
          console.warn(`[Estoque] Lote retry ${tentativa}/${MAX_RETRY} venda ${venda.id}...`);
          await new Promise(r => setTimeout(r, 800 * (tentativa - 1)));
        }

        try {
          resultados = [];

          await FirebaseService.runTransaction(async (tx) => {
            // ── Leitura única do estoque ────────────────────────────
            const estoqueRef = FirebaseService.docRef('ch_dados', 'estoque');
            const snap       = await tx.get(estoqueRef);
            const dadosFB    = snap.exists() ? (snap.data().dados || []) : [];
            const dadosMapa  = new Map(dadosFB.map(p => [p.id, { ...p }]));

            // ── Aplica TODAS as baixas no mapa local da transaction ──
            for (const { item, prod, qtdUn, origemKey } of itensParaBaixar) {
              const prodFB   = dadosMapa.get(item.prodId) || prod;
              const qtdAtual = prodFB.qtdUn ?? prodFB.estoqueAtual ?? 0;

              if (qtdAtual < qtdUn) {
                // Estoque insuficiente: registra erro mas não aborta os demais
                erros.push(`"${prod.nome}": insuficiente (${qtdAtual} disponível, ${qtdUn} solicitado)`);
                console.warn(`[Estoque] Lote: ${prod.nome} insuficiente, pulando`);
                continue;
              }

              const novaQtd = Math.max(0, qtdAtual - qtdUn);
              dadosMapa.set(item.prodId, {
                ...prodFB,
                qtdUn:       novaQtd,
                estoqueAtual: novaQtd,
                updatedAt:   Utils.nowISO(),
              });
              resultados.push({ produtoId: item.prodId, prod, qtdAntes: qtdAtual, qtdDepois: novaQtd, qtdUn, origemKey });
            }

            if (resultados.length === 0) return; // nada a escrever

            // ── Escrita única do estoque ────────────────────────────
            const novosDados = [...dadosMapa.values()];
            tx.set(estoqueRef, {
              dados:      novosDados,
              ts:         Utils.nowISO(),
              adminToken: _tok,
            });

            // ── Uma movimentação por item processado ────────────────
            for (const r of resultados) {
              const movRef = FirebaseService.newDocRef('movimentacoes');
              tx.set(movRef, {
                id:            movRef.id,
                produtoId:     r.produtoId,
                nomeProduto:   r.prod.nome,
                tipo:          'venda',
                quantidade:    -r.qtdUn,
                estoqueAntes:  r.qtdAntes,
                estoqueDepois: r.qtdDepois,
                origem:        r.origemKey,
                operador:      venda.operador || _usuario(),
                vendaId:       venda.id,
                timestamp:     Utils.nowISO(),
                dataCurta:     Utils.todayISO(),
                adminToken:    _tok,
              });
            }
          });

          // ── Atualiza store local UMA VEZ após transaction ────────
          if (resultados.length > 0) {
            Store.mutateEstoque(estoque => {
              for (const r of resultados) {
                const p = estoque.find(x => x.id === r.produtoId);
                if (p) { p.qtdUn = r.qtdDepois; p.estoqueAtual = r.qtdDepois; p.updatedAt = Utils.nowISO(); }
              }
            }, { _semSync: true }); // evita enfileirar SyncQueue — Firestore já tem o dado correto
          }

          sucesso = true;
          console.info(`[Estoque] ✓ Lote venda ${venda.id}: ${resultados.length} itens baixados (tentativa ${tentativa})`);
          break;

        } catch (e) {
          ultimoErr = e;
          console.warn(`[Estoque] Lote tentativa ${tentativa} falhou:`, e.message);
        }
      }

      if (!sucesso) {
        console.error(`[Estoque] ✗ Lote falhou após ${MAX_RETRY} tentativas:`, ultimoErr?.message);
        _registrarFalha({
          produtoId:   'lote',
          nomeProduto: `Venda ${venda.id} (${itensParaBaixar.length} itens)`,
          tipo:        'venda',
          origem:      `venda:${venda.id}`,
          erro:        ultimoErr?.message,
          tentativas:  MAX_RETRY,
          definitivo:  true,
        });
        // Fallback: aplica localmente para não perder a baixa
        _baixarLoteLocal(venda, itensParaBaixar);
        erros.push(`Firebase falhou após ${MAX_RETRY} tentativas — aplicado localmente`);
      }

      return { ok: sucesso, itensProcessados: resultados.length, erros };

    } else {
      // ── Modo offline / sem token ─────────────────────────────────
      const motivo = !_isOnline() ? 'offline' : !FirebaseService.isReady() ? 'Firebase não pronto' : 'sem adminToken';
      console.info(`[Estoque] Lote local (${motivo}) venda ${venda.id}`);
      _baixarLoteLocal(venda, itensParaBaixar);
      _agendarReconciliacao(`venda:${venda.id}`);
      return { ok: false, itensProcessados: itensParaBaixar.length, erros: [motivo] };
    }
  }

  /** Baixa local de todos os itens (fallback offline) */
  function _baixarLoteLocal(venda, itensParaBaixar) {
    const agora = new Date();
    Store.mutateEstoque(estoque => {
      for (const { item, prod, qtdUn, origemKey } of itensParaBaixar) {
        const p = estoque.find(x => x.id === item.prodId);
        if (!p) continue;
        const qtdAntes  = p.qtdUn ?? p.estoqueAtual ?? 0;
        const qtdDepois = Math.max(0, qtdAntes - qtdUn);
        p.qtdUn = qtdDepois; p.estoqueAtual = qtdDepois; p.updatedAt = Utils.nowISO();

        // Registra movimentação local
        Store.mutateMovimentacoes(movs => {
          movs.unshift({
            id: Utils.generateId(), produtoId: item.prodId, nomeProduto: prod.nome,
            tipo: 'venda', quantidade: -qtdUn, estoqueAntes: qtdAntes, estoqueDepois: qtdDepois,
            origem: origemKey, operador: venda.operador || _usuario(),
            timestamp: agora.toISOString(), dataCurta: Utils.todayISO(),
          });
        });
      }
    });
    console.info(`[Estoque] Lote local aplicado: ${itensParaBaixar.length} itens (venda ${venda.id})`);
  }

  /** Registra avaria/perda */
  async function registrarAvaria(produtoId, quantidade, observacao = '') {
    return _registrarMovimentacao({
      produtoId, tipo: 'avaria', quantidade, origem: 'avaria', observacao,
    });
  }

  /**
   * Ajuste de inventário — define a quantidade exata.
   * Calcula o delta entre o valor atual e o novo valor.
   */
  async function ajustarEstoque(produtoId, novaQuantidade, observacao = 'Ajuste de inventário') {
    const prod = getProduto(produtoId);
    if (!prod) throw new Error(`Produto ${produtoId} não encontrado`);

    const atual = prod.estoqueAtual ?? prod.qtdUn ?? 0;
    const diff  = novaQuantidade - atual;
    if (diff === 0) return null; // sem mudança

    return _registrarMovimentacao({
      produtoId,
      tipo:        'ajuste',
      quantidade:  Math.abs(diff), // irrelevante quando _forceDelta está presente
      origem:      'inventario',
      observacao,
      _forceDelta: diff, // diff já tem sinal: positivo=soma, negativo=subtrai
    });
  }

  /** Cancelamento de venda — estorna o estoque */
  async function cancelarVenda(vendaId, itens) {
    const movs = [];
    for (const item of itens) {
      const _prod = getProduto(item.prodId);
      const _pack = _prod?.packs?.find(pk =>
        pk.label === item.label || (pk.qtd + 'x') === item.label
      );
      const qtd = item.label === 'UNID'
        ? item.qtd
        : item.qtd * (_pack?.qtd || 1);
      const mov = await _registrarMovimentacao({
        produtoId:  item.prodId,
        tipo:       'cancelamento',
        quantidade: qtd,
        origem:     `cancelamento:${vendaId}`,
        observacao: `Cancelamento da venda ${vendaId}`,
      });
      movs.push(mov);
    }
    return movs;
  }

  // ── Consultas de movimentações ────────────────────────────────────
  function getMovimentacoes({ produtoId, tipo, dataDe, dataAte, limit = 500 } = {}) {
    let movs = Store.getMovimentacoes();
    if (produtoId) movs = movs.filter(m => m.produtoId === produtoId);
    if (tipo)      movs = movs.filter(m => m.tipo      === tipo);
    if (dataDe)    movs = movs.filter(m => m.dataCurta >= dataDe);
    if (dataAte)   movs = movs.filter(m => m.dataCurta <= dataAte);
    return movs.slice(0, limit);
  }

  function getMovimentacoesHoje() {
    return getMovimentacoes({ dataDe: Utils.todayISO(), dataAte: Utils.todayISO() });
  }

  // ── Alertas ───────────────────────────────────────────────────────
  function getProdutosAbaixoMinimo() {
    const thr = Store.getConfig()?.alertaEstoque || window.CH.CONSTANTS.LOW_STOCK;
    return getProdutos().filter(p => p.ativo && (p.estoqueAtual ?? p.qtdUn ?? 0) <= (p.estoqueMinimo || thr));
  }

  function getProdutosSemEstoque() {
    return getProdutos().filter(p => p.ativo && (p.estoqueAtual ?? p.qtdUn ?? 0) <= 0);
  }

  // ── Valorização do estoque ────────────────────────────────────────
  function getValorizacao() {
    const prods   = getProdutos().filter(p => p.ativo);
    const custo   = prods.reduce((s, p) => s + (p.precoCusto || p.custoUn || 0) * (p.estoqueAtual || p.qtdUn || 0), 0);
    const venda   = prods.reduce((s, p) => s + (p.precoVenda || p.precoUn  || 0) * (p.estoqueAtual || p.qtdUn || 0), 0);
    return { custo, venda, margem: venda - custo };
  }

  // ════════════════════════════════════════════════════════════════
  //  CATEGORIAS
  // ════════════════════════════════════════════════════════════════

  function getCategorias() { return Store.getCategorias(); }

  function adicionarCategoria(nome, cor = '#6b7280') {
    const cat = { id: Utils.generateId(), nome: nome.trim(), cor, createdAt: Utils.nowISO() };
    Store.mutateCategorias(cats => { cats.push(cat); });
    return cat;
  }

  function removerCategoria(id) {
    Store.mutateCategorias(cats => {
      const idx = cats.findIndex(c => c.id === id);
      if (idx >= 0) cats.splice(idx, 1);
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  FORNECEDORES
  // ════════════════════════════════════════════════════════════════

  function getFornecedores() { return Store.getFornecedores(); }
  function getFornecedor(id) { return Store.getFornecedores().find(f => f.id === id) || null; }

  function adicionarFornecedor({ nome, telefone = '', email = '', cnpj = '', observacao = '' }) {
    const forn = {
      id: Utils.generateId(), nome: nome.trim(), telefone, email, cnpj, observacao,
      ativo: true, createdAt: Utils.nowISO(),
    };
    Store.mutateFornecedores(forns => { forns.push(forn); });
    return forn;
  }

  function atualizarFornecedor(id, campos) {
    Store.mutateFornecedores(forns => {
      const f = forns.find(f => f.id === id);
      if (f) Object.assign(f, campos, { updatedAt: Utils.nowISO() });
    });
  }

  // ── Registro de falhas de estoque ───────────────────────────────
  /**
   * Registra uma falha de baixa de estoque no Firestore (coleção ch_falhas_estoque)
   * e envia alerta Telegram ao admin.
   */
  async function _registrarFalha({ produtoId, nomeProduto, tipo, origem, erro, esperado, encontrado, tentativas, definitivo }) {
    const falha = {
      produtoId, nomeProduto, tipo, origem,
      erro:       erro || null,
      esperado:   esperado ?? null,
      encontrado: encontrado ?? null,
      tentativas: tentativas || 1,
      definitivo: definitivo || false,
      operador:   _usuario(),
      timestamp:  Utils.nowISO(),
      dataCurta:  Utils.todayISO(),
    };
    console.error('[Estoque] Falha registrada:', falha);

    // Salva no Firestore para auditoria
    try {
      const _tok = FirebaseService.getAdminToken?.();
      if (_tok && FirebaseService.isReady()) {
        const falhaRef = FirebaseService.newDocRef('ch_falhas_estoque');
        await FirebaseService.setDoc(falhaRef, { ...falha, adminToken: _tok });
      }
    } catch (_) { /* salva localmente no mínimo */ }

    // Salva localmente
    try {
      const existentes = JSON.parse(localStorage.getItem('CH_FALHAS_ESTOQUE') || '[]');
      existentes.unshift(falha);
      localStorage.setItem('CH_FALHAS_ESTOQUE', JSON.stringify(existentes.slice(0, 50)));
    } catch (_) {}

    // Telegram — alerta imediato para o admin
    if (definitivo) {
      try {
        const msg =
          `🚨 <b>FALHA CRÍTICA — Estoque não baixou</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `📦 <b>Produto:</b> ${nomeProduto}\n` +
          `🔢 <b>Tipo:</b> ${tipo}\n` +
          `🔗 <b>Origem:</b> ${origem}\n` +
          `❌ <b>Erro:</b> ${erro || 'desconhecido'}\n` +
          `🔄 <b>Tentativas:</b> ${tentativas}\n` +
          `🕐 <b>Hora:</b> ${new Date().toLocaleString('pt-BR')}\n` +
          `\n⚠️ Execute a Reconciliação no painel de estoque para corrigir.`;
        window.CH?.TelegramService?.enviar?.(msg);
      } catch (_) {}
    }
  }

  // ── Reconciliação: agenda e executa ──────────────────────────────
  const _reconcPendentes = new Set();

  function _agendarReconciliacao(origem) {
    _reconcPendentes.add(origem);
    // Tenta reconciliar quando online
    const tentarReconciliar = async () => {
      if (!_isOnline() || !FirebaseService.isReady()) {
        setTimeout(tentarReconciliar, 10000);
        return;
      }
      for (const orig of [..._reconcPendentes]) {
        const vendaId = orig.replace('venda:', '');
        const venda   = Store.getVendas().find(v => v.id === vendaId);
        if (venda) {
          const corrigido = await _corrigirVenda(venda);
          if (corrigido) _reconcPendentes.delete(orig);
        } else {
          _reconcPendentes.delete(orig);
        }
      }
    };
    setTimeout(tentarReconciliar, 5000);
  }

  /**
   * Verifica se uma venda teve o estoque baixado e corrige se necessário.
   * Retorna true se ok, false se não conseguiu corrigir.
   */
  async function _corrigirVenda(venda) {
    try {
      const _tok = FirebaseService.getAdminToken?.();
      if (!_tok || !FirebaseService.isReady()) return false;

      // Lê movimentacoes do Firestore para verificar se venda já foi processada
      const movs = await FirebaseService.queryCollection('movimentacoes',
        [['origem', '==', `venda:${venda.id}`]]
      );
      if (movs && movs.length > 0) {
        console.info(`[Estoque] Reconciliação: venda ${venda.id} já tem movimentação, ok.`);
        return true;
      }

      console.warn(`[Estoque] Reconciliação: aplicando baixa pendente para venda ${venda.id}`);
      // FIX: usa item.prodId (não item.id) e item.qtd (não item.quantidade)
      // para corresponder ao modelo real de itens de venda
      if (venda.itens?.length) {
        try {
          const resultado = await baixarEstoqueVendaLote(venda);
          if (!resultado.ok && resultado.itensProcessados === 0) {
            console.error(`[Estoque] Reconciliação falhou para venda ${venda.id}:`, resultado.erros);
            return false;
          }
        } catch (e2) {
          console.error('[Estoque] Baixa em lote falhou na reconciliação:', e2.message);
          return false;
        }
      }
      return true;
    } catch (e) {
      console.error('[Estoque] Falha na reconciliação da venda:', venda.id, e.message);
      return false;
    }
  }

  /**
   * Reconciliação completa: varre todas as vendas do dia e verifica
   * se cada uma teve o estoque baixado. Corrige automaticamente as que falharam.
   * Pode ser chamada manualmente pelo admin ou via cron.
   * Retorna relatório { verificadas, corrigidas, falhas, detalhes[] }
   */
  async function reconciliarEstoque(vendas) {
    const _tok = FirebaseService.getAdminToken?.();
    if (!_tok || !FirebaseService.isReady()) {
      return { ok: false, motivo: 'Sem adminToken ou Firebase offline' };
    }

    // FIX CRÍTICO: status corretos do sistema são 'concluida' e 'validada'
    // (não 'aprovado', 'validado', 'finalizado' — esses não existem)
    const alvo = vendas || Store.getVendas().filter(v =>
      v.dataCurta === Utils.todayISO() &&
      ['concluida', 'validada'].includes(v.status)
    );

    const relatorio = { verificadas: 0, corrigidas: 0, falhas: 0, detalhes: [] };

    for (const venda of alvo) {
      if (!venda.itens?.length) continue;
      relatorio.verificadas++;

      try {
        // Busca movimentacoes no Firestore para esta venda
        const movs = await FirebaseService.queryCollection('movimentacoes',
          [['origem', '==', `venda:${venda.id}`]]
        );

        if (movs && movs.length > 0) {
          relatorio.detalhes.push({ vendaId: venda.id, status: 'ok', msg: 'Movimentação já existe' });
          continue;
        }

        // FIX: usa baixarEstoqueVendaLote (atômico) em vez de loop item-a-item
        // Não há mais baixarEstoqueVenda com assinatura (prodId, qtd, vendaId)
        console.warn(`[Estoque] Reconciliação: venda ${venda.id} sem movimentação, corrigindo...`);
        try {
          const resCorr = await baixarEstoqueVendaLote(venda);
          if (resCorr.ok || resCorr.itensProcessados > 0) {
            relatorio.corrigidas++;
            relatorio.detalhes.push({ vendaId: venda.id, status: 'corrigido', msg: `${resCorr.itensProcessados} itens ajustados` });
          } else {
            relatorio.falhas++;
            relatorio.detalhes.push({ vendaId: venda.id, status: 'falhou', msg: resCorr.erros?.join('; ') || 'Baixa falhou' });
          }
        } catch (eLote) {
          relatorio.falhas++;
          relatorio.detalhes.push({ vendaId: venda.id, status: 'falhou', msg: eLote.message });
        }

      } catch (e) {
        relatorio.falhas++;
        relatorio.detalhes.push({ vendaId: venda.id, status: 'falhou', msg: e.message });
      }
    }

    // Telegram com resultado
    try {
      const msg =
        `🔄 <b>Reconciliação de Estoque — CH Geladas</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `✅ <b>Verificadas:</b> ${relatorio.verificadas}\n` +
        `🔧 <b>Corrigidas:</b> ${relatorio.corrigidas}\n` +
        `❌ <b>Falhas:</b> ${relatorio.falhas}\n` +
        `🕐 ${new Date().toLocaleString('pt-BR')}` +
        (relatorio.falhas > 0 ? '\n\n⚠️ Algumas vendas não puderam ser corrigidas. Verifique manualmente.' : '');
      window.CH?.TelegramService?.enviar?.(msg);
    } catch (_) {}

    console.info('[Estoque] Reconciliação concluída:', relatorio);
    return relatorio;
  }

  /** Retorna lista de falhas registradas localmente */
  function getFalhasEstoque() {
    try { return JSON.parse(localStorage.getItem('CH_FALHAS_ESTOQUE') || '[]'); } catch(_) { return []; }
  }

  // ── Exportar ─────────────────────────────────────────────────────
  window.CH.EstoqueService = {
    // Produtos
    getProdutos,
    getProduto,
    adicionarProduto,
    atualizarProduto,
    removerProduto,

    // Movimentações
    entradaEstoque,
    baixarEstoqueVenda,
    registrarAvaria,
    ajustarEstoque,
    cancelarVenda,
    getMovimentacoes,
    getMovimentacoesHoje,

    // Reserva de Estoque (anti-paradoxo)
    reservarEstoque,
    liberarReserva,
    getQtdReservada,
    getEstoqueDisponivel,
    getReservas,

    // Alertas
    getProdutosAbaixoMinimo,
    getProdutosSemEstoque,
    getValorizacao,

    // Categorias
    getCategorias,
    adicionarCategoria,
    removerCategoria,

    // Fornecedores
    getFornecedores,
    getFornecedor,
    adicionarFornecedor,
    atualizarFornecedor,

    // Baixa em lote (todos os itens de uma venda em 1 transaction)
    baixarEstoqueVendaLote,

    // Reconciliação e auditoria de estoque
    reconciliarEstoque,
    getFalhasEstoque,
  };

  console.info('%c EstoqueService ✓  (Transactions + Movimentações + Reserva de Estoque)', 'color:#10b981');
})();
