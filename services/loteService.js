'use strict';
/**
 * services/loteService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Rastreabilidade de investimento/custo por lote de compra (FIFO).
 *
 * MODELO — CompraLote (coleção 'lotes', 1 doc por lote):
 *   {
 *     id, empresaId, produtoId, produtoNome,
 *     fornecedorId, fornecedorNome,
 *     dataCompra, unidadeCompra,
 *     quantidadeInicial, quantidadeDisponivel,
 *     custoMercadoria, frete, desconto, outrasDespesas, custoTotalReal,
 *     custoUnitario,        // alta precisão (6 casas) — ver custoService
 *     status,                // 'ativo' | 'esgotado' | 'devolvido'
 *     origemCompraId,        // referência externa opcional (idempotência)
 *     createdAt, updatedAt, createdBy,
 *   }
 *
 * MODELO — MovimentacaoLote (coleção 'movimentacoesLote', 1 doc por evento):
 *   {
 *     id, empresaId, loteId, produtoId,
 *     tipo,                  // 'ENTRADA_COMPRA' | 'SAIDA_VENDA' | 'ESTORNO' | 'DEVOLUCAO' | 'AJUSTE'
 *     quantidade,             // sempre positiva; o `tipo` indica o sentido
 *     saldoAnterior, saldoPosterior,   // saldo do LOTE (não do produto agregado)
 *     custoUnitario, custoTotal,
 *     origem, origemId,       // ex.: origem='venda', origemId=vendaId — chave de idempotência
 *     operador, observacao,
 *     timestamp, dataCurta,
 *   }
 *
 * IDEMPOTÊNCIA: toda operação que referencia origem+origemId confere se já
 * existe movimentação com essa chave antes de agir de novo — mesmo padrão
 * já usado em estoqueService.baixarEstoqueVenda().
 *
 * CONCORRÊNCIA: consumirFIFO usa Firebase Transaction por lote (cada lote é
 * seu próprio documento) quando online — evita duas vendas simultâneas em
 * aparelhos diferentes consumirem além do disponível do mesmo lote. Sem
 * conexão, aplica local e deixa o SyncQueue reconciliar depois.
 *
 * Requer: core.js, services/custoService.js, services/tenantService.js
 * carregados antes.
 */

(function () {
  const { Store, AuthService, Utils, EventBus, FirebaseService } = window.CH;

  function _usuario() { return AuthService.getNome(); }
  function _isOnline() { return navigator.onLine; }
  function _empresaId() { return window.CH.TenantService.getEmpresaId(); }

  // ══════════════════════════════════════════════════════════════════
  //  PLANEJAMENTO FIFO — função pura, sem I/O, 100% testável isolada
  // ══════════════════════════════════════════════════════════════════

  /**
   * Decide de quais lotes consumir `quantidadeNecessaria` unidades, em
   * ordem FIFO (lote mais antigo primeiro). Não muta nada — só planeja.
   *
   * @param {Array} lotesDisponiveis  [{ id, dataCompra, quantidadeDisponivel, custoUnitario }, ...]
   * @param {number} quantidadeNecessaria
   * @returns {{ parcelas: Array<{loteId,quantidade,custoUnitario}>, faltante: number }}
   *          faltante > 0 significa estoque insuficiente nos lotes ativos.
   */
  function planejarConsumoFIFO(lotesDisponiveis, quantidadeNecessaria) {
    const EPS = 1e-9; // tolerância pra comparação de ponto flutuante em quantidades fracionadas
    const ordenados = [...(lotesDisponiveis || [])]
      .filter(l => (l.quantidadeDisponivel || 0) > EPS)
      .sort((a, b) => new Date(a.dataCompra) - new Date(b.dataCompra) || String(a.id).localeCompare(String(b.id)));

    let restante = quantidadeNecessaria;
    const parcelas = [];

    for (const lote of ordenados) {
      if (restante <= EPS) break;
      const consumir = Math.min(lote.quantidadeDisponivel, restante);
      if (consumir <= EPS) continue;
      parcelas.push({ loteId: lote.id, quantidade: consumir, custoUnitario: lote.custoUnitario });
      restante -= consumir;
    }

    const faltante = restante > EPS ? restante : 0;
    return { parcelas, faltante };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CRIAR LOTE (entrada de compra)
  // ══════════════════════════════════════════════════════════════════

  /**
   * Cria um CompraLote a partir de uma compra confirmada. Idempotente por
   * `origemCompraId` — uma segunda chamada com o mesmo origemCompraId
   * retorna o lote já existente em vez de duplicar.
   *
   * CONVERSÃO DE UNIDADE (Seção 31): se `unidadeProduto` for informada e
   * for diferente de `unidadeCompra` (ex.: comprou em KG mas o produto é
   * vendido em G), a quantidade é convertida automaticamente e o lote
   * passa a existir na unidade de VENDA do produto — assim o FIFO, o CMV
   * e a rentabilidade sempre trabalham numa unidade só por produto, sem
   * precisar converter de novo em nenhum outro lugar do sistema. Se as
   * unidades forem incompatíveis (ex.: comprou em L pra um produto vendido
   * em KG), lança erro em vez de adivinhar — nunca cria um lote com
   * quantidade errada silenciosamente.
   */
  async function criarLote({
    produtoId, produtoNome, fornecedorId = null, fornecedorNome = '',
    dataCompra = Utils.nowISO(), unidadeCompra = 'UN', unidadeProduto = null, unidadeCompraOriginal = undefined,
    quantidadeInicial, custoMercadoria, frete = 0, desconto = 0, outrasDespesas = 0,
    observacao = '', origemCompraId = null,
  }) {
    if (!produtoId) throw new Error('produtoId é obrigatório para criar um lote.');
    if (!(quantidadeInicial > 0)) throw new Error('quantidadeInicial precisa ser maior que zero.');

    if (origemCompraId) {
      const existente = Store.getLotes().find(l => l.origemCompraId === origemCompraId);
      if (existente) {
        console.info('[LoteService] Lote já existia para origemCompraId, ignorando duplicata:', origemCompraId);
        return existente;
      }
    }

    const Custo = window.CH.CustoService;
    let quantidadeFinal = quantidadeInicial;
    let unidadeFinal = unidadeCompra;
    let unidadeOriginalFinal = unidadeCompraOriginal;
    // Só converte aqui se o CALLER não converteu antes (ex.: chamada direta
    // a criarLote, sem passar por estoqueService.entradaEstoque, que já
    // faz sua própria conversão e informa unidadeCompraOriginal explícita).
    if (unidadeCompraOriginal === undefined && unidadeProduto && unidadeProduto !== unidadeCompra) {
      quantidadeFinal = Custo.converterQuantidade(quantidadeInicial, unidadeCompra, unidadeProduto);
      unidadeFinal = unidadeProduto;
      unidadeOriginalFinal = unidadeCompra;
      console.info(`[LoteService] Convertido ${quantidadeInicial}${unidadeCompra} → ${quantidadeFinal}${unidadeProduto} para o lote de ${produtoNome}`);
    }

    const custo = Custo.calcularCustoReal({ custoMercadoria, frete, desconto, outrasDespesas });
    const custoUnitario = Custo.custoUnitarioPreciso(custo.custoTotalReal, quantidadeFinal);

    const lote = {
      id: Utils.generateId(),
      empresaId: _empresaId(),
      produtoId, produtoNome,
      fornecedorId, fornecedorNome,
      dataCompra, unidadeCompra: unidadeFinal,
      unidadeCompraOriginal: unidadeOriginalFinal,
      quantidadeInicial: quantidadeFinal,
      quantidadeDisponivel: quantidadeFinal,
      ...custo,
      custoUnitario,
      status: 'ativo',
      origemCompraId,
      observacao,
      createdAt: Utils.nowISO(),
      updatedAt: Utils.nowISO(),
      createdBy: _usuario(),
    };

    Store.mutateLotes(lotes => { lotes.unshift(lote); });

    const mov = {
      id: Utils.generateId(),
      empresaId: lote.empresaId,
      loteId: lote.id,
      produtoId,
      tipo: 'ENTRADA_COMPRA',
      quantidade: quantidadeInicial,
      saldoAnterior: 0,
      saldoPosterior: quantidadeInicial,
      custoUnitario,
      custoTotal: custo.custoTotalReal,
      origem: 'compra',
      origemId: origemCompraId,
      operador: _usuario(),
      observacao,
      timestamp: Utils.nowISO(),
      dataCurta: Utils.todayISO(),
    };
    Store.mutateMovimentacoesLote(movs => { movs.unshift(mov); });

    window.CH.AuditService?.registrar?.('LOTE_CRIADO', 'lotes', {
      detalhe: `${produtoNome}: ${quantidadeInicial} ${unidadeCompra} · custo real ${custo.custoTotalReal}`,
      referencia: lote.id,
    });
    EventBus.emit('lote:criado', lote);
    return lote;
  }

  // ══════════════════════════════════════════════════════════════════
  //  CONSUMIR FIFO (venda)
  // ══════════════════════════════════════════════════════════════════

  /**
   * Consome `quantidade` unidades do produto via FIFO, gerando o CMV real
   * (soma dos custos de cada lote efetivamente consumido).
   *
   * Idempotente: se já existe movimentação com origem+origemId para este
   * produto, retorna o resultado já registrado em vez de consumir de novo.
   * Bloqueia (lança erro) se o total disponível nos lotes for insuficiente
   * — nunca consome parcialmente em silêncio.
   */
  async function consumirFIFO(produtoId, quantidade, { origem, origemId, operador = null, observacao = '' } = {}) {
    if (!(quantidade > 0)) throw new Error('Quantidade a consumir precisa ser maior que zero.');

    if (origem && origemId) {
      const jaProcessado = Store.getMovimentacoesLote().filter(
        m => m.produtoId === produtoId && m.origem === origem && m.origemId === origemId && m.tipo === 'SAIDA_VENDA'
      );
      if (jaProcessado.length) {
        console.info(`[LoteService] Consumo já processado para ${origem}:${origemId}, retornando resultado existente.`);
        const Custo = window.CH.CustoService;
        return Custo.calcularCMV(jaProcessado.map(m => ({ loteId: m.loteId, quantidade: m.quantidade, custoUnitario: m.custoUnitario })));
      }
    }

    const lotesDoProduto = Store.getLotes().filter(l => l.produtoId === produtoId && l.status === 'ativo');
    const { parcelas, faltante } = planejarConsumoFIFO(lotesDoProduto, quantidade);

    if (faltante > 0) {
      throw new Error(
        `Estoque em lote insuficiente para consumir ${quantidade} unidade(s): ` +
        `faltam ${faltante} (sem lote de origem para cobrir o CMV desta quantidade).`
      );
    }

    // Aplica cada parcela — transacional por lote quando online, local + fila quando offline.
    for (const parcela of parcelas) {
      await _aplicarConsumoLote(parcela, { produtoId, origem, origemId, operador, observacao });
    }

    const Custo = window.CH.CustoService;
    const resultado = Custo.calcularCMV(parcelas);
    EventBus.emit('lote:consumido', { produtoId, origem, origemId, ...resultado });
    return resultado;
  }

  async function _aplicarConsumoLote(parcela, { produtoId, origem, origemId, operador, observacao }) {
    const lote = Store.getLotes().find(l => l.id === parcela.loteId);
    if (!lote) throw new Error(`Lote ${parcela.loteId} não encontrado ao aplicar consumo.`);

    const saldoAnterior = lote.quantidadeDisponivel;
    const saldoPosterior = Math.max(0, saldoAnterior - parcela.quantidade);
    const _tok = FirebaseService.getAdminToken?.();
    let aplicadoViaTransacao = false;

    if (_isOnline() && FirebaseService.isReady?.() && _tok) {
      try {
        await FirebaseService.runTransaction(async (tx) => {
          const ref  = FirebaseService.docRef('lotes', lote.id);
          const snap = await tx.get(ref);
          if (!snap.exists()) throw new Error(`Lote ${lote.id} não existe no Firestore.`);
          const atual = snap.data();
          const qtdAtualFB = atual.quantidadeDisponivel ?? 0;
          if (qtdAtualFB < parcela.quantidade - 1e-9) {
            throw new Error(`Lote ${lote.id} sem saldo suficiente no servidor (disponível ${qtdAtualFB}, pedido ${parcela.quantidade}).`);
          }
          const novoSaldo = Math.max(0, qtdAtualFB - parcela.quantidade);
          tx.update(ref, {
            quantidadeDisponivel: novoSaldo,
            status: novoSaldo <= 1e-9 ? 'esgotado' : 'ativo',
            updatedAt: Utils.nowISO(),
          });
          const movRef = FirebaseService.newDocRef('movimentacoesLote');
          tx.set(movRef, {
            id: movRef.id, empresaId: lote.empresaId, loteId: lote.id, produtoId,
            tipo: 'SAIDA_VENDA', quantidade: parcela.quantidade,
            saldoAnterior: qtdAtualFB, saldoPosterior: novoSaldo,
            custoUnitario: parcela.custoUnitario,
            custoTotal: window.CH.CustoService.paraCentavos(parcela.quantidade * parcela.custoUnitario),
            origem: origem || 'venda', origemId: origemId || null,
            operador: operador || _usuario(), observacao,
            timestamp: Utils.nowISO(), dataCurta: Utils.todayISO(),
            _fbSynced: true, syncedAt: Utils.nowISO(),
          });
        });
        aplicadoViaTransacao = true;
      } catch (e) {
        console.warn('[LoteService] Transação de consumo falhou, aplicando localmente:', e.message);
      }
    }

    // Aplica local sempre (é o que popula o Store/UI imediatamente; quando
    // a transação já rodou no servidor, usa _semSync pra não reenfileirar
    // uma escrita "salvar" comum por cima e derrubar a próxima transaction —
    // mesmo cuidado já documentado em core.js/_mutate).
    Store.mutateLotes(lotes => {
      const l = lotes.find(x => x.id === parcela.loteId);
      if (l) { l.quantidadeDisponivel = saldoPosterior; l.status = saldoPosterior <= 1e-9 ? 'esgotado' : 'ativo'; l.updatedAt = Utils.nowISO(); }
    }, aplicadoViaTransacao ? { _semSync: true } : {});

    if (!aplicadoViaTransacao) {
      const mov = {
        id: Utils.generateId(), empresaId: lote.empresaId, loteId: lote.id, produtoId,
        tipo: 'SAIDA_VENDA', quantidade: parcela.quantidade,
        saldoAnterior, saldoPosterior,
        custoUnitario: parcela.custoUnitario,
        custoTotal: window.CH.CustoService.paraCentavos(parcela.quantidade * parcela.custoUnitario),
        origem: origem || 'venda', origemId: origemId || null,
        operador: operador || _usuario(), observacao,
        timestamp: Utils.nowISO(), dataCurta: Utils.todayISO(),
      };
      Store.mutateMovimentacoesLote(movs => { movs.unshift(mov); });
    } else {
      // A movimentação já foi gravada dentro da transaction (Firestore) —
      // espelha no Store local pra ficar disponível na hora, sem reenfileirar.
      Store.mutateMovimentacoesLote(movs => {
        movs.unshift({
          id: Utils.generateId(), empresaId: lote.empresaId, loteId: lote.id, produtoId,
          tipo: 'SAIDA_VENDA', quantidade: parcela.quantidade, saldoAnterior, saldoPosterior,
          custoUnitario: parcela.custoUnitario,
          custoTotal: window.CH.CustoService.paraCentavos(parcela.quantidade * parcela.custoUnitario),
          origem: origem || 'venda', origemId: origemId || null,
          operador: operador || _usuario(), observacao,
          timestamp: Utils.nowISO(), dataCurta: Utils.todayISO(),
        });
      }, { _semSync: true });
    }

    window.CH.AuditService?.registrar?.('ESTOQUE_SAIDA_LOTE', 'lotes', {
      detalhe: `Lote ${lote.id.slice(0,8)}: -${parcela.quantidade} (${origem}:${origemId||'-'})`,
      referencia: lote.id,
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  ESTORNO (cancelamento de venda) — Seção 22
  // ══════════════════════════════════════════════════════════════════

  /**
   * Reverte o consumo de lote associado a uma origem+origemId (ex.: venda
   * cancelada). Devolve a quantidade ao(s) lote(s) originalmente
   * consumido(s) e registra uma movimentação ESTORNO — nunca apaga a
   * movimentação SAIDA_VENDA original.
   * Idempotente: um segundo estorno da mesma origem+origemId não duplica.
   */
  async function reverterConsumo(produtoId, { origem, origemId, operador = null, observacao = 'Estorno' } = {}) {
    const saidas = Store.getMovimentacoesLote().filter(
      m => m.produtoId === produtoId && m.origem === origem && m.origemId === origemId && m.tipo === 'SAIDA_VENDA'
    );
    if (!saidas.length) {
      console.info('[LoteService] Nada para estornar em', origem, origemId);
      return { revertido: false, motivo: 'nenhuma saída encontrada' };
    }
    const jaEstornado = Store.getMovimentacoesLote().some(
      m => m.produtoId === produtoId && m.origem === origem && m.origemId === origemId && m.tipo === 'ESTORNO'
    );
    if (jaEstornado) {
      console.info('[LoteService] Estorno já processado para', origem, origemId);
      return { revertido: false, motivo: 'já estornado' };
    }

    for (const saida of saidas) {
      const lote = Store.getLotes().find(l => l.id === saida.loteId);
      if (!lote) continue; // lote pode ter sido removido — segue mesmo assim pras demais parcelas
      const saldoAnterior = lote.quantidadeDisponivel;
      const saldoPosterior = Math.min(lote.quantidadeInicial, saldoAnterior + saida.quantidade);

      Store.mutateLotes(lotes => {
        const l = lotes.find(x => x.id === saida.loteId);
        if (l) { l.quantidadeDisponivel = saldoPosterior; l.status = 'ativo'; l.updatedAt = Utils.nowISO(); }
      });

      Store.mutateMovimentacoesLote(movs => {
        movs.unshift({
          id: Utils.generateId(), empresaId: lote.empresaId, loteId: lote.id, produtoId,
          tipo: 'ESTORNO', quantidade: saida.quantidade,
          saldoAnterior, saldoPosterior,
          custoUnitario: saida.custoUnitario, custoTotal: saida.custoTotal,
          origem, origemId, operador: operador || _usuario(), observacao,
          timestamp: Utils.nowISO(), dataCurta: Utils.todayISO(),
        });
      });
    }

    window.CH.AuditService?.registrar?.('ESTORNO', 'lotes', { detalhe: `Estorno de ${origem}:${origemId}`, referencia: origemId });
    EventBus.emit('lote:estornado', { produtoId, origem, origemId });
    return { revertido: true };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CONSULTAS
  // ══════════════════════════════════════════════════════════════════

  function getLotesProduto(produtoId) {
    return Store.getLotes()
      .filter(l => l.produtoId === produtoId)
      .sort((a, b) => new Date(b.dataCompra) - new Date(a.dataCompra));
  }

  function getLote(loteId) {
    return Store.getLotes().find(l => l.id === loteId) || null;
  }

  function getMovimentacoesProduto(produtoId) {
    return Store.getMovimentacoesLote()
      .filter(m => m.produtoId === produtoId)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  /** Saldo consolidado de investimento/estoque de um produto, com base nos lotes. */
  function getSaldoProduto(produtoId) {
    const lotes = getLotesProduto(produtoId);
    const quantidadeComprada   = lotes.reduce((s, l) => s + l.quantidadeInicial, 0);
    const quantidadeDisponivel = lotes.reduce((s, l) => s + l.quantidadeDisponivel, 0);
    const investimentoTotal    = lotes.reduce((s, l) => s + l.custoTotalReal, 0);
    const investimentoRestante = window.CH.CustoService.paraCentavos(
      lotes.reduce((s, l) => s + l.quantidadeDisponivel * l.custoUnitario, 0)
    );
    return { lotes, quantidadeComprada, quantidadeDisponivel, investimentoTotal, investimentoRestante };
  }

  // ══════════════════════════════════════════════════════════════════
  //  DEVOLUÇÃO DE COMPRA AO FORNECEDOR — Seção 23
  // ══════════════════════════════════════════════════════════════════

  /**
   * Registra a devolução de `quantidade` unidades de um lote ao
   * fornecedor. Só pode devolver o que ainda está DISPONÍVEL no lote
   * (não afeta unidades já vendidas — pra isso é estorno de venda, não
   * devolução de compra). Reduz `quantidadeDisponivel` permanentemente
   * (a mercadoria sai da loja de vez); NÃO altera `quantidadeInicial`
   * nem `custoUnitario` — o histórico de "quanto foi comprado" e o CMV
   * já registrado em vendas anteriores desse lote continuam intactos
   * (mesmo espírito de nunca recalcular o passado, Seção 21).
   *
   * Quem chama isso pra também baixar o estoque AGREGADO do produto é
   * `estoqueService.devolucaoCompra()` — este método aqui só cuida da
   * parte de lote/rastreabilidade.
   */
  async function registrarDevolucao(loteId, quantidade, { motivo = '', operador = null } = {}) {
    const lote = getLote(loteId);
    if (!lote) throw new Error(`Lote ${loteId} não encontrado.`);
    if (!(quantidade > 0)) throw new Error('Quantidade a devolver precisa ser maior que zero.');
    if (quantidade > lote.quantidadeDisponivel + 1e-9) {
      throw new Error(
        `Não é possível devolver ${quantidade}: só há ${lote.quantidadeDisponivel} disponível neste lote ` +
        `(o restante já foi vendido — devolução de compra só cobre o que ainda está em estoque).`
      );
    }

    const saldoAnterior = lote.quantidadeDisponivel;
    const saldoPosterior = Math.max(0, saldoAnterior - quantidade);

    Store.mutateLotes(lotes => {
      const l = lotes.find(x => x.id === loteId);
      if (l) { l.quantidadeDisponivel = saldoPosterior; l.status = saldoPosterior <= 1e-9 ? 'esgotado' : 'ativo'; l.updatedAt = Utils.nowISO(); }
    });

    const mov = {
      id: Utils.generateId(), empresaId: lote.empresaId, loteId, produtoId: lote.produtoId,
      tipo: 'DEVOLUCAO', quantidade,
      saldoAnterior, saldoPosterior,
      custoUnitario: lote.custoUnitario,
      custoTotal: window.CH.CustoService.paraCentavos(quantidade * lote.custoUnitario),
      origem: 'devolucao', origemId: null,
      operador: operador || _usuario(), observacao: motivo,
      timestamp: Utils.nowISO(), dataCurta: Utils.todayISO(),
    };
    Store.mutateMovimentacoesLote(movs => { movs.unshift(mov); });

    window.CH.AuditService?.registrar?.('DEVOLUCAO', 'lotes', {
      detalhe: `Lote ${loteId.slice(0,8)}: devolução de ${quantidade} un ao fornecedor · ${motivo}`,
      referencia: loteId,
    });
    EventBus.emit('lote:devolvido', { loteId, produtoId: lote.produtoId, quantidade });
    return mov;
  }

  window.CH = window.CH || {};
  window.CH.LoteService = {
    planejarConsumoFIFO, criarLote, consumirFIFO, reverterConsumo, registrarDevolucao,
    getLote, getLotesProduto, getMovimentacoesProduto, getSaldoProduto,
  };
  console.info('%c loteService ✓', 'color:#64748b');
})();
