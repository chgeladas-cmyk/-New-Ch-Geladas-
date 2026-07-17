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
      if (prod.controlaEstoque === false) continue;
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
    if (!reservas[vendaId]) return;
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
      qtdUn:              p.qtdUn       ?? estoqueAtual,
      precoUn:            p.precoUn     ?? p.precoVenda ?? 0,
      custoUn:            p.custoUn     ?? p.precoCusto ?? 0,
      ativo:              p.ativo       ?? true,
      unidade:            p.unidade     ?? 'UN',
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
   * Se offline ou sem token, aplica localmente.
   */
  async function _registrarMovimentacao({
    produtoId,
    tipo,
    quantidade,
    origem       = 'manual',
    operador     = null,
    observacao   = '',
    custo        = null,
    fornecedorId = null,
    _forceDelta  = null,
  }) {
    const prod = getProduto(produtoId);
    if (!prod) throw new Error(`Produto ${produtoId} não encontrado`);

    const estoqueAntes = prod.estoqueAtual ?? prod.qtdUn ?? 0;

    let delta;
    if (_forceDelta !== null) {
      delta = _forceDelta;
    } else {
      const eSaida = ['venda','avaria','transferencia'].includes(tipo);
      delta = eSaida ? -Math.abs(quantidade) : Math.abs(quantidade);
    }

    const estoqueDepois = Math.max(0, estoqueAntes + delta);
    const eSaida = delta < 0;

    const _tok = FirebaseService.getAdminToken?.();

    if (_isOnline() && FirebaseService.isReady() && _tok) {
      try {
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

          const novaQtd    = Math.max(0, qtdAtualFB + delta);
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

        Store.mutateEstoque(estoque => {
          const p = estoque.find(p => p.id === produtoId);
          if (p) { p.qtdUn = estoqueDepois; p.estoqueAtual = estoqueDepois; p.updatedAt = Utils.nowISO(); }
        });

        console.info(`[Estoque] ✓ Transação ${tipo}: ${prod.nome} (${estoqueAntes}→${estoqueDepois})`);

      } catch (e) {
        if (e.message?.includes('insuficiente')) throw e;
        console.warn(`[Estoque] Transaction falhou, aplicando localmente: ${e.message}`);
        _movimentacaoLocal({ produtoId, prod, tipo, delta, estoqueAntes, estoqueDepois, origem, operador, observacao, custo, fornecedorId });
      }

    } else {
      const motivo = !_isOnline() ? 'offline' : !FirebaseService.isReady() ? 'Firebase não pronto' : 'sem adminToken';
      console.info(`[Estoque] Modo local (${motivo}): ${tipo} ${prod.nome}`);
      _movimentacaoLocal({ produtoId, prod, tipo, delta, estoqueAntes, estoqueDepois, origem, operador, observacao, custo, fornecedorId });
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
   * Idempotente: uma segunda chamada com o mesmo vendaId não baixa de novo.
   */
  async function baixarEstoqueVenda(produtoId, quantidade, vendaId) {
    if (vendaId) {
      const origemKey = `venda:${vendaId}`;
      const jaProcessado = Store.getMovimentacoes().some(
        m => m.origem === origemKey && m.produtoId === produtoId && m.tipo === 'venda'
      );
      if (jaProcessado) {
        console.info(`[EstoqueService] baixarEstoqueVenda ignorado — venda ${vendaId} já processada para produto ${produtoId}`);
        return null;
      }
    }
    return _registrarMovimentacao({
      produtoId, tipo: 'venda', quantidade,
      origem: `venda:${vendaId}`,
    });
  }

  /**
   * BAIXA TODOS OS ITENS DE UMA VENDA EM UMA ÚNICA TRANSACTION.
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

    const itensParaBaixar = [];
    for (const item of venda.itens) {
      const prod = getProduto(item.prodId);
      if (!prod)                          continue;
      if (prod.controlaEstoque === false) continue;

      const origemKey    = `venda:${venda.id}`;
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

    const erros = [];

    // ── Modo Firebase: UMA transaction para todos os itens ──────────
    if (_isOnline() && FirebaseService.isReady() && _tok) {
      let resultados = [];
      let jaProcessadoNoServidor = false;

      try {
        await FirebaseService.runTransaction(async (tx) => {
          const estoqueRef = FirebaseService.docRef('ch_dados', 'estoque');
          const vendaRef   = FirebaseService.docRef('vendas', venda.id);

          const [snap, vendaSnap] = await Promise.all([tx.get(estoqueRef), tx.get(vendaRef)]);

          // ── GUARD ATÔMICO ──────────────────────────────────────────
          // Lê `_baixouEstoque` do PRÓPRIO doc da venda dentro desta mesma
          // transaction. Se já for true (baixado por este ou outro
          // dispositivo), aborta sem tocar no estoque de novo. É isso que
          // fecha a corrida de "tentar novamente" / reprocessamento
          // concorrente entre dispositivos.
          if (vendaSnap.exists() && vendaSnap.data()?._baixouEstoque === true) {
            jaProcessadoNoServidor = true;
            resultados = [];
            return;
          }

          const dadosFB    = snap.exists() ? (snap.data().dados || []) : [];
          const dadosMapa  = new Map(dadosFB.map(p => [p.id, { ...p }]));

          resultados = [];

          for (const { item, prod, qtdUn, origemKey } of itensParaBaixar) {
            const prodFB   = dadosMapa.get(item.prodId) || prod;
            const qtdAtual = prodFB.qtdUn ?? prodFB.estoqueAtual ?? 0;

            if (qtdAtual < qtdUn) {
              erros.push(`"${prod.nome}": insuficiente (${qtdAtual} disponível, ${qtdUn} solicitado)`);
              console.warn(`[Estoque] Lote: ${prod.nome} insuficiente, pulando`);
              continue;
            }

            const novaQtd = Math.max(0, qtdAtual - qtdUn);
            dadosMapa.set(item.prodId, {
              ...prodFB,
              qtdUn:        novaQtd,
              estoqueAtual: novaQtd,
              updatedAt:    Utils.nowISO(),
            });
            resultados.push({ produtoId: item.prodId, prod, qtdAntes: qtdAtual, qtdDepois: novaQtd, qtdUn, origemKey });
          }

          if (resultados.length === 0) return;

          const novosDados = [...dadosMapa.values()];
          tx.set(estoqueRef, {
            dados:      novosDados,
            ts:         Utils.nowISO(),
            adminToken: _tok,
          });

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

          // Marca a baixa como concluída no PRÓPRIO doc da venda, na MESMA
          // transaction do débito de estoque — guard atômico de verdade,
          // não depende do sync do array local de vendas ter completado.
          if (vendaSnap.exists()) {
            tx.set(vendaRef, { _baixouEstoque: true, _baixaEm: Utils.nowISO() }, { merge: true });
          }
        });

        if (jaProcessadoNoServidor) {
          console.info(`[Estoque] Lote venda ${venda.id}: já baixado (bloqueado pelo guard atômico) — ignorando repetição.`);
          return { ok: true, itensProcessados: 0, erros: [], jaProcessado: true };
        }

        if (resultados.length > 0) {
          Store.mutateEstoque(estoque => {
            for (const r of resultados) {
              const p = estoque.find(x => x.id === r.produtoId);
              if (p) { p.qtdUn = r.qtdDepois; p.estoqueAtual = r.qtdDepois; p.updatedAt = Utils.nowISO(); }
            }
          }, { _semSync: true });

          // Espelha localmente as movimentações já confirmadas no Firestore.
          // Antes só o fallback offline fazia isso — deixando o guard
          // `jaProcessado` (baseado em Store.getMovimentacoes()) cego
          // justamente no caminho online, que é o mais usado.
          Store.mutateMovimentacoes(movs => {
            for (const r of resultados) {
              movs.unshift({
                id:            Utils.generateId(),
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
              });
            }
          });

          for (const r of resultados) {
            window.CH.AuditService?.auditarMovimentacao({
              nomeProduto:   r.prod.nome,
              produtoId:     r.produtoId,
              tipo:          'venda',
              quantidade:    -r.qtdUn,
              estoqueAntes:  r.qtdAntes,
              estoqueDepois: r.qtdDepois,
              origem:        r.origemKey,
              vendaId:       venda.id,
            });
          }
        }

        console.info(`[Estoque] ✓ Lote venda ${venda.id}: ${resultados.length} itens baixados`);
        return { ok: true, itensProcessados: resultados.length, erros };

      } catch (e) {
        console.warn(`[Estoque] Lote transaction falhou, aplicando localmente:`, e.message);
        _baixarLoteLocal(venda, itensParaBaixar);
        erros.push(`Firebase falhou — aplicado localmente`);
        return {
          ok:               false,
          localFallback:    true,
          itensProcessados: itensParaBaixar.length,
          erros,
        };
      }

    } else {
      // ── Modo offline / sem token ─────────────────────────────────
      const motivo = !_isOnline() ? 'offline' : !FirebaseService.isReady() ? 'Firebase não pronto' : 'sem adminToken';
      console.info(`[Estoque] Lote local (${motivo}) venda ${venda.id}`);
      _baixarLoteLocal(venda, itensParaBaixar);
      return { ok: false, localFallback: true, itensProcessados: itensParaBaixar.length, erros: [motivo] };
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

        Store.mutateMovimentacoes(movs => {
          movs.unshift({
            id: Utils.generateId(), produtoId: item.prodId, nomeProduto: prod.nome,
            tipo: 'venda', quantidade: -qtdUn, estoqueAntes: qtdAntes, estoqueDepois: qtdDepois,
            origem: origemKey, operador: venda.operador || _usuario(),
            timestamp: agora.toISOString(), dataCurta: Utils.todayISO(),
          });
        });

        window.CH.AuditService?.auditarMovimentacao({
          nomeProduto:   prod.nome,
          produtoId:     item.prodId,
          tipo:          'venda',
          quantidade:    -qtdUn,
          estoqueAntes:  qtdAntes,
          estoqueDepois: qtdDepois,
          origem:        origemKey,
          vendaId:       venda.id,
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
    if (diff === 0) return null;

    return _registrarMovimentacao({
      produtoId,
      tipo:        'ajuste',
      quantidade:  Math.abs(diff),
      origem:      'inventario',
      observacao,
      _forceDelta: diff,
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
    const prods = getProdutos().filter(p => p.ativo);
    const custo = prods.reduce((s, p) => s + (p.precoCusto || p.custoUn || 0) * (p.estoqueAtual || p.qtdUn || 0), 0);
    const venda = prods.reduce((s, p) => s + (p.precoVenda || p.precoUn  || 0) * (p.estoqueAtual || p.qtdUn || 0), 0);
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

  // ── Reconciliação manual ─────────────────────────────────────────
  /**
   * Reconciliação completa: varre todas as vendas do dia e verifica
   * se cada uma teve o estoque baixado. Corrige automaticamente as que falharam.
   * Retorna relatório { verificadas, corrigidas, falhas, detalhes[] }
   */
  async function reconciliarEstoque(vendas) {
    const _tok = FirebaseService.getAdminToken?.();
    if (!_tok || !FirebaseService.isReady()) {
      return { ok: false, motivo: 'Sem adminToken ou Firebase offline' };
    }

    const alvo = vendas || Store.getVendas().filter(v =>
      v.dataCurta === Utils.todayISO() &&
      ['concluida', 'validada'].includes(v.status)
    );

    const relatorio = { verificadas: 0, corrigidas: 0, falhas: 0, detalhes: [] };

    for (const venda of alvo) {
      if (!venda.itens?.length) continue;
      relatorio.verificadas++;

      try {
        const movs = await FirebaseService.queryCollection('movimentacoes',
          [['origem', '==', `venda:${venda.id}`]]
        );

        if (movs && movs.length > 0) {
          relatorio.detalhes.push({ vendaId: venda.id, status: 'ok', msg: 'Movimentação já existe' });
          continue;
        }

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
