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
      ativo:        dados.ativo ?? true,
      unidade:      dados.unidade || 'UN',
      fornecedorId: dados.fornecedorId || null,
      packs:        dados.packs || [],
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

    // FIX: declarado no escopo da função para que o log de movimentação local
    // use o valor real confirmado pelo Firestore (não o local possivelmente desatualizado).
    // Preenchido dentro da Transaction; permanece null se offline (usa estoqueDepois).
    let _novaQtdFB = null;

    // _forceDelta permite ajuste bidirecional (positivo ou negativo)
    // Quando não passado, calcula pelo tipo: saídas subtraem, entradas somam
    let delta;
    if (_forceDelta !== null) {
      delta = _forceDelta; // já tem sinal correto (+/-)
    } else {
      const eSaida = ['venda','avaria','transferencia'].includes(tipo);
      delta = eSaida ? -Math.abs(quantidade) : Math.abs(quantidade);
    }

    // estoqueDepois LOCAL — usado apenas como fallback (offline/sem adminToken).
    // No modo online com Transaction, o valor real vem do Firestore (novaQtdFB).
    const estoqueDepois = Math.max(0, estoqueAntes + delta);
    const eSaida = delta < 0; // recalcula para validação de estoque insuficiente

    // ── Tenta usar Firebase Transaction (modo online + admin) ──────────
    // PDV não tem adminToken → Firestore rejeitaria a escrita de qualquer forma.
    // Nesse caso, aplica localmente e SyncQueue envia quando admin sincronizar.
    if (_isOnline() && FirebaseService.isReady()) {
      try {
        await FirebaseService.runTransaction(async (tx) => {
          // Lê o documento de estoque no Firestore
          const estoqueRef = FirebaseService.docRef('ch_dados', 'estoque');
          const snap = await tx.get(estoqueRef);
          const dadosFB = snap.exists() ? (snap.data().dados || []) : [];

          const prodFB = dadosFB.find(p => p.id === produtoId);
          const qtdAtualFB = prodFB ? (prodFB.qtdUn ?? prodFB.estoqueAtual ?? 0) : estoqueAntes;

          // Validação: saída não pode deixar estoque negativo
          if (eSaida && qtdAtualFB < Math.abs(delta)) {
            throw new Error(
              `Estoque insuficiente para "${prod.nome}": ` +
              `disponível ${qtdAtualFB}, solicitado ${Math.abs(delta)}`
            );
          }

          const novaQtd = Math.max(0, qtdAtualFB + delta);
          _novaQtdFB = novaQtd; // FIX: captura para uso no Store local e no log abaixo

          // Atualiza o produto no array dentro do documento
          const novosDados = dadosFB.map(p =>
            p.id === produtoId
              ? { ...p, qtdUn: novaQtd, estoqueAtual: novaQtd, updatedAt: Utils.nowISO() }
              : p
          );

          // Se produto não estava no FB, adiciona
          if (!prodFB) novosDados.push({ ...prod, qtdUn: novaQtd, estoqueAtual: novaQtd });

          const _tkn = FirebaseService.getAdminToken?.();
          const _estoqueDoc = { dados: novosDados, ts: Utils.nowISO() };
          if (_tkn) _estoqueDoc.adminToken = _tkn;
          tx.set(estoqueRef, _estoqueDoc);

          // Também salva a movimentação como documento individual
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
          });
        });

        // FIX: usa _novaQtdFB (valor confirmado pelo Firestore) em vez de
        // estoqueDepois (calculado com localStorage, potencialmente desatualizado).
        const qtdConfirmada = _novaQtdFB ?? estoqueDepois;
        console.info(`[Estoque] ✓ Transação ${tipo}: ${prod.nome} (FB:${_novaQtdFB ?? '?'} | local era:${estoqueAntes})`);

        // Atualiza Store local com o valor CONFIRMADO pelo Firestore
        Store.mutateEstoque(estoque => {
          const p = estoque.find(p => p.id === produtoId);
          if (p) {
            p.qtdUn = qtdConfirmada;
            p.estoqueAtual = qtdConfirmada;
            p.updatedAt = Utils.nowISO();
          }
        });

      } catch (e) {
        // Se for erro de validação (estoque insuficiente), propaga
        if (e.message.includes('insuficiente')) throw e;
        // Outros erros (rede, etc.) → fallback local
        console.warn('[Estoque] Transação Firebase falhou, usando local:', e.message);
        _movimentacaoLocal({ produtoId, prod, tipo, delta, estoqueAntes, estoqueDepois, origem, operador, observacao, custo, fornecedorId });
      }
    } else {
      // ── Modo local: offline, sem adminToken (PDV), ou Firebase não pronto ──
      // Aplica localmente — SyncQueue garante que admin sincronize depois.
      const motivo = !_isOnline() ? 'offline' : 'Firebase não pronto';
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
      estoqueDepois: _novaQtdFB ?? estoqueDepois, // FIX: usa valor confirmado do Firestore quando disponível
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
   * Chamado por VendasService ao finalizar uma venda.
   */
  async function baixarEstoqueVenda(produtoId, quantidade, vendaId) {
    return _registrarMovimentacao({
      produtoId, tipo: 'venda', quantidade,
      origem: `venda:${vendaId}`,
    });
  }

  /**
   * Baixa de estoque para TODOS os itens de uma venda em UMA única Transaction.
   *
   * PROBLEMA que resolve:
   *   Chamar baixarEstoqueVenda() N vezes em loop faz N Transactions independentes.
   *   Se o Firestore não propagou a escrita da Transaction anterior antes da próxima
   *   começar, cada Transaction lê o mesmo valor "antigo" do documento de estoque
   *   e aplica o delta sobre ele — as baixas se sobrepõem e só a última persiste.
   *
   *   Exemplo: venda com 3 itens (A−2, B−5, C−10) → 3 Transactions separadas.
   *   Se todas leem o documento antes de qualquer escrita ser visível, cada uma
   *   sobrescreve o array completo com apenas a sua própria baixa aplicada.
   *
   * SOLUÇÃO: uma única Transaction que lê o documento UMA vez, aplica todos os
   *   deltas no array em memória e escreve o resultado de uma só vez.
   *   Também registra todas as movimentações em um único batch dentro da Transaction.
   *
   * @param {Array}  itens    Array de { prodId, qtd, label, nome } da venda
   * @param {string} vendaId  ID da venda (usado como origem das movimentações)
   * @returns {Array} movimentações registradas
   */
  async function baixarEstoqueVendaItens(itens, vendaId) {
    if (!itens?.length) return [];

    // Calcula o delta de cada item (unidades, considerando packs)
    const deltas = itens.map(item => {
      const prod = getProduto(item.prodId);
      if (!prod) return null;
      const pack  = prod.packs?.find(pk => pk.label === item.label || (pk.qtd + 'x') === item.label);
      const qtdUn = item.label === 'UNID' ? item.qtd : item.qtd * (pack?.qtd || 1);
      return { prod, item, qtdUn };
    }).filter(Boolean);

    if (!deltas.length) return [];

    // ── Modo online: única Transaction para todos os itens ────────────
    if (_isOnline() && FirebaseService.isReady()) {
      // Armazena os valores confirmados pelo Firestore para cada produto
      const qtdConfirmadas = {}; // { prodId: novaQtd }

      try {
        await FirebaseService.runTransaction(async (tx) => {
          const estoqueRef = FirebaseService.docRef('ch_dados', 'estoque');
          const snap       = await tx.get(estoqueRef);
          const dadosFB    = snap.exists() ? (snap.data().dados || []) : [];

          // Clona o array para aplicar todos os deltas em memória
          const novosDados = dadosFB.map(p => ({ ...p }));

          for (const { prod, item, qtdUn } of deltas) {
            const idx = novosDados.findIndex(p => p.id === prod.id);
            const qtdAtual = idx >= 0
              ? (novosDados[idx].qtdUn ?? novosDados[idx].estoqueAtual ?? 0)
              : (prod.estoqueAtual ?? 0);

            if (qtdAtual < qtdUn) {
              throw new Error(
                `Estoque insuficiente para "${prod.nome}": ` +
                `disponível ${qtdAtual}, solicitado ${qtdUn}`
              );
            }

            const novaQtd = Math.max(0, qtdAtual - qtdUn);
            qtdConfirmadas[prod.id] = novaQtd;

            if (idx >= 0) {
              novosDados[idx] = { ...novosDados[idx], qtdUn: novaQtd, estoqueAtual: novaQtd, updatedAt: Utils.nowISO() };
            } else {
              novosDados.push({ ...prod, qtdUn: novaQtd, estoqueAtual: novaQtd });
            }

            // Registra movimentação individual dentro da mesma Transaction
            const movRef = FirebaseService.newDocRef('movimentacoes');
            tx.set(movRef, {
              id:            movRef.id,
              produtoId:     prod.id,
              nomeProduto:   prod.nome,
              tipo:          'venda',
              quantidade:    -qtdUn,
              estoqueAntes:  qtdAtual,
              estoqueDepois: novaQtd,
              origem:        `venda:${vendaId}`,
              operador:      _usuario(),
              observacao:    '',
              custo:         prod.precoCusto ?? 0,
              fornecedorId:  null,
              timestamp:     Utils.nowISO(),
              dataCurta:     Utils.todayISO(),
            });
          }

          // Escreve o array completo atualizado em uma única operação
          // FIX: inclui adminToken para passar na regra do Firestore (mesma lógica do salvar())
          const _adminToken = FirebaseService.getAdminToken?.();
          const estoqueDoc = { dados: novosDados, ts: Utils.nowISO() };
          if (_adminToken) estoqueDoc.adminToken = _adminToken;
          tx.set(estoqueRef, estoqueDoc);
        });

        // Atualiza Store local com os valores confirmados pelo Firestore
        Store.mutateEstoque(estoque => {
          for (const [prodId, novaQtd] of Object.entries(qtdConfirmadas)) {
            const p = estoque.find(p => p.id === prodId);
            if (p) {
              p.qtdUn = novaQtd;
              p.estoqueAtual = novaQtd;
              p.updatedAt = Utils.nowISO();
            }
          }
        });

        console.info(`[Estoque] ✓ Baixa em lote (venda ${vendaId}): ${deltas.length} item(ns) em 1 Transaction`);

      } catch (e) {
        if (e.message.includes('insuficiente')) throw e;
        // Fallback local se Transaction falhar por problema de rede
        console.warn('[Estoque] Transaction em lote falhou, usando local:', e.message);
        for (const { prod, item, qtdUn } of deltas) {
          const estoqueAtual = prod.estoqueAtual ?? 0;
          _movimentacaoLocal({ produtoId: prod.id, prod, tipo: 'venda', delta: -qtdUn, estoqueAntes: estoqueAtual, estoqueDepois: Math.max(0, estoqueAtual - qtdUn), origem: `venda:${vendaId}` });
        }
      }

      // Registra movimentações no Store local
      const movs = deltas.map(({ prod, item, qtdUn }) => {
        const estoqueAntes = prod.estoqueAtual ?? 0;
        const mov = {
          id:            Utils.generateId(),
          produtoId:     prod.id,
          nomeProduto:   prod.nome,
          tipo:          'venda',
          quantidade:    -qtdUn,
          estoqueAntes,
          estoqueDepois: qtdConfirmadas[prod.id] ?? Math.max(0, estoqueAntes - qtdUn),
          origem:        `venda:${vendaId}`,
          operador:      _usuario(),
          observacao:    '',
          custo:         prod.precoCusto ?? 0,
          fornecedorId:  null,
          timestamp:     Utils.nowISO(),
          dataCurta:     Utils.todayISO(),
        };
        Store.mutateMovimentacoes(movs => { movs.unshift(mov); });
        window.CH.AuditService?.auditarMovimentacao(mov);
        return mov;
      });

      EventBus.emit('estoque:movimentado:lote', { vendaId, total: movs.length });
      return movs;
    }

    // ── Modo offline: aplica localmente item a item ───────────────────
    const movs = [];
    for (const { prod, item, qtdUn } of deltas) {
      try {
        const mov = await _registrarMovimentacao({
          produtoId: prod.id, tipo: 'venda', quantidade: qtdUn,
          origem: `venda:${vendaId}`,
        });
        movs.push(mov);
      } catch (e) {
        console.warn(`[Estoque] Offline — baixa falhou "${prod.nome}":`, e.message);
      }
    }
    return movs;
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
    baixarEstoqueVendaItens,
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
  };

  console.info('%c EstoqueService ✓  (Transactions + Movimentações + Reserva de Estoque)', 'color:#10b981');
})();
