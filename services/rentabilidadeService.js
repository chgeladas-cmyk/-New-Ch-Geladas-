'use strict';
/**
 * services/rentabilidadeService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Camada de agregação: junta lotes + movimentações de lote pra responder
 * as perguntas do documento de rastreabilidade (quanto investi, quanto
 * vendi, quanto lucrei, ROI, margem, quanto ainda tenho investido, quanto
 * ainda posso faturar) — sempre decompondo até a origem (lote/movimentação),
 * nunca um número solto sem rastro.
 *
 * IMPORTANTE: este serviço NÃO recalcula nada a partir do custo ATUAL do
 * produto — tudo vem das movimentações de lote já gravadas no momento de
 * cada venda (CMV congelado), exatamente o que o documento pede na Seção 9
 * ("não recalcular vendas antigas utilizando o custo atual do produto").
 *
 * Produtos sem nenhum lote (estoque criado antes desta funcionalidade
 * existir) simplesmente não aparecem aqui — não há investimento rastreável
 * pra eles ainda. Ver nota em estoqueService.entradaEstoque.
 *
 * Requer: core.js, services/custoService.js, services/loteService.js
 * carregados antes.
 */

(function () {
  const { Store } = window.CH;

  function _custo() { return window.CH.CustoService; }
  function _lote()  { return window.CH.LoteService; }

  /**
   * Rentabilidade completa de UM produto — a "tela de Rentabilidade do
   * Produto" (Seção 16) inteira vem daqui.
   */
  function getRentabilidadeProduto(produtoId, produtoNome = '') {
    const lotes = _lote().getLotesProduto(produtoId);
    if (!lotes.length) return null; // sem lote = sem rastreabilidade ainda

    const movs = _lote().getMovimentacoesProduto(produtoId);
    const saidas = movs.filter(m => m.tipo === 'SAIDA_VENDA');

    const quantidadeComprada   = lotes.reduce((s, l) => s + l.quantidadeInicial, 0);
    const quantidadeVendida    = saidas.reduce((s, m) => s + m.quantidade, 0);
    const quantidadeDisponivel = lotes.reduce((s, l) => s + l.quantidadeDisponivel, 0);

    const investimentoInicial  = lotes.reduce((s, l) => s + l.custoTotalReal, 0);
    const cmvRealizado         = _custo().paraCentavos(saidas.reduce((s, m) => s + m.custoTotal, 0));
    const investimentoRestante = _custo().paraCentavos(
      lotes.reduce((s, l) => s + l.quantidadeDisponivel * l.custoUnitario, 0)
    );

    // Receita bruta: soma o que cada venda realmente cobrou por essa
    // quantidade. A movimentação de lote não guarda o preço de venda (só
    // custo) — por isso a receita vem das PRÓPRIAS vendas (Store.getVendas),
    // casando pelo mesmo par origem/origemId usado no consumo FIFO.
    const vendaIds = [...new Set(saidas.map(m => m.origemId).filter(Boolean))];
    const vendas = Store.getVendas().filter(v => vendaIds.includes(v.id));
    let receitaBruta = 0;
    for (const v of vendas) {
      for (const item of (v.itens || [])) {
        if (item.prodId === produtoId) receitaBruta += (item.preco || 0) * (item.qtd || 0);
      }
    }
    receitaBruta = _custo().paraCentavos(receitaBruta);

    const lucroRealizado = _custo().paraCentavos(receitaBruta - cmvRealizado);
    const margem = _custo().calcularMargem(lucroRealizado, receitaBruta);
    const roi    = _custo().calcularROI(lucroRealizado, investimentoInicial);

    // Lucro potencial: se vender o restante do estoque ao preço de venda
    // ATUAL do produto (é a única leitura "atual" aceitável aqui — o
    // documento distingue explicitamente realizado x potencial, Seção 15).
    const prod = window.CH.EstoqueService?.getProduto?.(produtoId);
    const precoVendaAtual = prod?.precoVenda ?? prod?.precoUn ?? 0;
    const receitaPotencial = _custo().paraCentavos(quantidadeDisponivel * precoVendaAtual);
    const lucroPotencial   = _custo().paraCentavos(receitaPotencial - investimentoRestante);

    const status = quantidadeDisponivel <= 1e-9
      ? (lucroRealizado >= 0 ? 'INVESTIMENTO TOTALMENTE RECUPERADO' : 'INVESTIMENTO NÃO RECUPERADO (PREJUÍZO)')
      : (cmvRealizado >= investimentoInicial ? 'INVESTIMENTO RECUPERADO — ESTOQUE RESTANTE É LUCRO' : 'INVESTIMENTO PARCIALMENTE RECUPERADO');

    return {
      produtoId, produtoNome: produtoNome || lotes[0].produtoNome,
      investimentoInicial, quantidadeComprada, quantidadeVendida, quantidadeDisponivel,
      receitaBruta, cmvRealizado, lucroRealizado, margem, roi,
      investimentoRestante, receitaPotencial, lucroPotencial,
      status,
      lotes: lotes.map(l => ({
        id: l.id, dataCompra: l.dataCompra, quantidadeInicial: l.quantidadeInicial,
        quantidadeDisponivel: l.quantidadeDisponivel, custoTotalReal: l.custoTotalReal,
        custoUnitario: l.custoUnitario, status: l.status,
      })),
      vendas: saidas.map(m => ({
        movimentacaoId: m.id, vendaId: m.origemId, loteId: m.loteId,
        quantidade: m.quantidade, custoUnitario: m.custoUnitario, custoTotal: m.custoTotal,
        timestamp: m.timestamp,
      })),
    };
  }

  /** Relatório "ROI por produto" (Seção 33) — todos os produtos com lote, ordenável. */
  function getRelatorioROI({ ordenarPor = 'roi', desc = true } = {}) {
    const produtosComLote = [...new Set(Store.getLotes().map(l => l.produtoId))];
    const linhas = produtosComLote
      .map(pid => getRentabilidadeProduto(pid))
      .filter(Boolean);

    const chaves = {
      roi: r => r.roi, lucro: r => r.lucroRealizado, investimento: r => r.investimentoInicial,
      estoqueParado: r => r.investimentoRestante, margem: r => r.margem,
    };
    const chave = chaves[ordenarPor] || chaves.roi;
    linhas.sort((a, b) => desc ? chave(b) - chave(a) : chave(a) - chave(b));
    return linhas;
  }

  /** Dashboard consolidado (Seção 17, parte financeira). */
  function getDashboardConsolidado() {
    const linhas = getRelatorioROI();
    const soma = (fn) => _custo().paraCentavos(linhas.reduce((s, r) => s + fn(r), 0));
    return {
      totalInvestidoEstoque: soma(r => r.investimentoRestante),
      totalVendido:          soma(r => r.quantidadeVendida > 0 ? r.receitaBruta : 0),
      receitaBruta:          soma(r => r.receitaBruta),
      cmvTotal:              soma(r => r.cmvRealizado),
      lucroBrutoTotal:       soma(r => r.lucroRealizado),
      margemMedia:           linhas.length ? _custo().arredondar(linhas.reduce((s,r)=>s+r.margem,0) / linhas.length, 2) : 0,
      lucroPotencialTotal:   soma(r => r.lucroPotencial),
      produtosComPrejuizo:   linhas.filter(r => r.lucroRealizado < 0).length,
      produtosSemVenda:      linhas.filter(r => r.quantidadeVendida <= 1e-9).length,
      qtdProdutosRastreados: linhas.length,
    };
  }

  /**
   * Alertas gerenciais (Seção 34). Limiares configuráveis via
   * `Store.getConfig().rentabilidade` (mesmo padrão já usado por
   * `cfg.alertaEstoque` no estoqueService) — usa padrão sensato se a loja
   * nunca configurou nada.
   */
  function getAlertas() {
    const { Store } = window.CH;
    const cfg = Store.getConfig()?.rentabilidade || {};
    const margemMinima        = cfg.margemMinima ?? 20;   // %
    const diasEstoqueParado   = cfg.diasEstoqueParado ?? 30;
    const roiObjetivo         = cfg.roiObjetivo ?? 50;    // %

    const alertas = [];
    const agora = Date.now();
    const lotesPorProduto = new Map();
    for (const l of Store.getLotes()) {
      if (l.status !== 'ativo') continue;
      if (!lotesPorProduto.has(l.produtoId)) lotesPorProduto.set(l.produtoId, []);
      lotesPorProduto.get(l.produtoId).push(l);
    }

    for (const r of getRelatorioROI()) {
      const prod = window.CH.EstoqueService?.getProduto?.(r.produtoId);
      const precoVendaAtual = prod?.precoVenda ?? prod?.precoUn ?? 0;

      // 🔴 Prejuízo: existe lote ativo cujo custo unitário já é maior que o preço de venda atual
      const lotesAtivos = lotesPorProduto.get(r.produtoId) || [];
      const loteComPrejuizo = lotesAtivos.find(l => l.custoUnitario > precoVendaAtual);
      if (loteComPrejuizo) {
        alertas.push({
          tipo: 'prejuizo', icone: '🔴', produtoId: r.produtoId, produtoNome: r.produtoNome,
          detalhe: `Preço de venda (${_custo().paraCentavos(precoVendaAtual)}) é menor que o custo do lote ${loteComPrejuizo.id.slice(0,8)} (${loteComPrejuizo.custoUnitario.toFixed(2)}/un)`,
        });
      }

      // 🟠 Margem baixa (só avalia produto que já teve venda — sem venda ainda não tem margem real)
      if (r.quantidadeVendida > 0 && r.margem < margemMinima) {
        alertas.push({
          tipo: 'margem_baixa', icone: '🟠', produtoId: r.produtoId, produtoNome: r.produtoNome,
          detalhe: `Margem realizada de ${r.margem}% está abaixo do mínimo configurado (${margemMinima}%)`,
        });
      }

      // 🟡 Estoque parado: tem lote ativo mas sem nenhuma venda há mais de X dias (ou nunca vendeu)
      if (r.quantidadeDisponivel > 1e-9) {
        const ultimaVenda = r.vendas.reduce((max, v) => Math.max(max, new Date(v.timestamp).getTime()), 0);
        const referencia = ultimaVenda || Math.min(...lotesAtivos.map(l => new Date(l.dataCompra).getTime()));
        const diasParado = Math.floor((agora - referencia) / 86400000);
        if (diasParado >= diasEstoqueParado) {
          alertas.push({
            tipo: 'estoque_parado', icone: '🟡', produtoId: r.produtoId, produtoNome: r.produtoNome,
            detalhe: `${diasParado} dia(s) sem vender, com ${r.quantidadeDisponivel} ainda em estoque (${window.CH.Utils.formatCurrency(r.investimentoRestante)} parados)`,
          });
        }
      }

      // 🟢 Alto retorno
      if (r.quantidadeVendida > 0 && r.roi >= roiObjetivo) {
        alertas.push({
          tipo: 'alto_retorno', icone: '🟢', produtoId: r.produtoId, produtoNome: r.produtoNome,
          detalhe: `ROI de ${r.roi}% já superou a meta configurada (${roiObjetivo}%)`,
        });
      }
    }

    return alertas;
  }
  window.CH = window.CH || {};
  window.CH.RentabilidadeService = { getRentabilidadeProduto, getRelatorioROI, getDashboardConsolidado, getAlertas };
  console.info('%c rentabilidadeService ✓', 'color:#64748b');
})();
