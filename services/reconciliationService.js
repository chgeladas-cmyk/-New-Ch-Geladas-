'use strict';
/**
 * services/reconciliationService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Rotina de conciliação (Seção 28 do documento de rastreabilidade):
 * confere se estoque agregado × lotes × movimentações de lote × vendas
 * estão consistentes entre si, e reporta cada divergência encontrada —
 * nunca "conserta" nada sozinho, só detecta e relata (correção é uma
 * decisão humana, com auditoria).
 *
 * A lógica de verificação (`verificarConsistencia`) é uma função PURA —
 * recebe os arrays já carregados e devolve a lista de divergências, sem
 * tocar em Store/Firebase. Isso permite testar exaustivamente com dados
 * sintéticos (inclusive dados propositalmente quebrados) sem precisar de
 * um ambiente de banco de verdade.
 *
 * Requer: core.js, services/custoService.js carregados antes (para rodar
 * via executarReconciliacao(); verificarConsistencia() sozinha não
 * precisa de nada além do que é passado por parâmetro).
 */

(function () {
  const EPS = 1e-6;

  function _custo() { return window.CH?.CustoService; }

  /**
   * @param {Object} dados
   * @param {Array} dados.estoque             — Store.getEstoque()
   * @param {Array} dados.lotes               — Store.getLotes()
   * @param {Array} dados.movimentacoesLote   — Store.getMovimentacoesLote()
   * @param {Array} dados.vendas              — Store.getVendas()
   * @returns {Array<{tipo, severidade, produtoId, produtoNome, loteId, detalhe}>}
   */
  function verificarConsistencia({ estoque = [], lotes = [], movimentacoesLote = [], vendas = [] } = {}) {
    const divergencias = [];
    const add = (tipo, severidade, produtoId, produtoNome, detalhe, loteId = null) =>
      divergencias.push({ tipo, severidade, produtoId, produtoNome, loteId, detalhe });

    const produtosPorId = new Map(estoque.map(p => [p.id, p]));
    const lotesPorProduto = new Map();
    for (const l of lotes) {
      if (!lotesPorProduto.has(l.produtoId)) lotesPorProduto.set(l.produtoId, []);
      lotesPorProduto.get(l.produtoId).push(l);
    }
    const movsPorLote = new Map();
    for (const m of movimentacoesLote) {
      if (!movsPorLote.has(m.loteId)) movsPorLote.set(m.loteId, []);
      movsPorLote.get(m.loteId).push(m);
    }

    // ── 1) Por lote: saldo negativo, custo/quantidade inválidos,
    //      consumido além do comprado, saldo divergente do histórico
    //      de movimentações, CMV de cada parcela mal calculado ──────
    for (const lote of lotes) {
      const nome = lote.produtoNome || produtosPorId.get(lote.produtoId)?.nome || lote.produtoId;

      if (lote.quantidadeDisponivel < -EPS) {
        add('lote_saldo_negativo', 'alta', lote.produtoId, nome,
          `Lote ${lote.id.slice(0,8)}: saldo disponível negativo (${lote.quantidadeDisponivel})`, lote.id);
      }
      if (lote.custoUnitario < 0 || lote.quantidadeInicial <= 0) {
        add('lote_dados_invalidos', 'alta', lote.produtoId, nome,
          `Lote ${lote.id.slice(0,8)}: custoUnitario=${lote.custoUnitario}, quantidadeInicial=${lote.quantidadeInicial}`, lote.id);
      }

      const movs = movsPorLote.get(lote.id) || [];
      const totalSaidas      = movs.filter(m => m.tipo === 'SAIDA_VENDA').reduce((s, m) => s + m.quantidade, 0);
      const totalEstornos    = movs.filter(m => m.tipo === 'ESTORNO').reduce((s, m) => s + m.quantidade, 0);
      const totalDevolucoes  = movs.filter(m => m.tipo === 'DEVOLUCAO').reduce((s, m) => s + m.quantidade, 0);
      // Saídas que reduzem o saldo: vendas E devoluções ao fornecedor.
      // Entradas que aumentam de volta: estornos de venda cancelada.
      const consumoLiquido = totalSaidas - totalEstornos + totalDevolucoes;

      if (consumoLiquido > lote.quantidadeInicial + EPS) {
        add('lote_consumido_alem_do_comprado', 'alta', lote.produtoId, nome,
          `Lote ${lote.id.slice(0,8)}: consumo líquido ${consumoLiquido} (vendas+devoluções-estornos) > quantidade comprada ${lote.quantidadeInicial}`, lote.id);
      }

      const saldoEsperado = lote.quantidadeInicial - consumoLiquido;
      if (Math.abs(saldoEsperado - lote.quantidadeDisponivel) > EPS) {
        add('lote_saldo_diverge_do_historico', 'alta', lote.produtoId, nome,
          `Lote ${lote.id.slice(0,8)}: saldo armazenado ${lote.quantidadeDisponivel} ≠ saldo calculado pelo histórico ${saldoEsperado}`, lote.id);
      }

      for (const m of movs) {
        if (!['SAIDA_VENDA', 'ESTORNO', 'DEVOLUCAO'].includes(m.tipo)) continue;
        const esperado = _custo() ? _custo().paraCentavos(m.quantidade * m.custoUnitario) : Math.round(m.quantidade * m.custoUnitario * 100) / 100;
        if (Math.abs(esperado - m.custoTotal) > 0.01) {
          add('cmv_parcela_incorreta', 'alta', lote.produtoId, nome,
            `Movimentação ${m.id.slice(0,8)} (${m.tipo}): custoTotal registrado ${m.custoTotal} ≠ quantidade×custoUnitario ${esperado}`, lote.id);
        }
      }
    }

    // ── 2) Por produto: estoque agregado × soma dos lotes ativos ────
    for (const [produtoId, lotesDoProduto] of lotesPorProduto) {
      const prod = produtosPorId.get(produtoId);
      if (!prod) {
        add('lote_sem_produto', 'media', produtoId, lotesDoProduto[0]?.produtoNome || produtoId,
          `Existe(m) ${lotesDoProduto.length} lote(s) para um produto que não está mais cadastrado no estoque`);
        continue;
      }
      const somaLotes = lotesDoProduto.reduce((s, l) => s + l.quantidadeDisponivel, 0);
      const estoqueAgregado = prod.estoqueAtual ?? prod.qtdUn ?? 0;
      if (Math.abs(somaLotes - estoqueAgregado) > EPS) {
        add('saldo_agregado_diverge', 'alta', produtoId, prod.nome,
          `Estoque agregado do produto (${estoqueAgregado}) ≠ soma dos lotes ativos (${somaLotes})`);
      }
    }

    // ── 3) Produtos com estoque mas sem nenhum lote (esperado pra
    //      produtos legados — severidade baixa, é aviso, não erro) ──
    for (const p of estoque) {
      const qtd = p.estoqueAtual ?? p.qtdUn ?? 0;
      if (qtd > EPS && !lotesPorProduto.has(p.id)) {
        add('estoque_sem_lote', 'baixa', p.id, p.nome,
          `Produto tem ${qtd} em estoque mas nenhum lote de compra registrado (sem rastreabilidade de custo ainda)`);
      }
    }

    // ── 4) Vendas de produtos COM lote que não geraram consumo de lote ──
    for (const venda of vendas) {
      if (venda.status === 'cancelada' || venda.status === 'rejeitada') continue;
      for (const item of (venda.itens || [])) {
        if (!lotesPorProduto.has(item.prodId)) continue; // produto sem lote — já coberto no check 3
        const existeConsumo = movimentacoesLote.some(
          m => m.tipo === 'SAIDA_VENDA' && m.produtoId === item.prodId && m.origem === 'venda' && m.origemId === venda.id
        );
        if (!existeConsumo) {
          const nome = produtosPorId.get(item.prodId)?.nome || item.prodId;
          add('venda_sem_consumo_de_lote', 'media', item.prodId, nome,
            `Venda ${venda.id} vendeu ${item.qtd} un mas não há movimentação de lote correspondente (CMV real não registrado para este item)`);
        }
      }
    }

    return divergencias;
  }

  /** Roda a verificação usando os dados atuais do Store, e loga no AuditService se houver divergências. */
  function executarReconciliacao() {
    const { Store } = window.CH;
    const dados = {
      estoque: Store.getEstoque(),
      lotes: Store.getLotes(),
      movimentacoesLote: Store.getMovimentacoesLote(),
      vendas: Store.getVendas(),
    };
    const divergencias = verificarConsistencia(dados);

    if (divergencias.length) {
      window.CH.AuditService?.registrar?.('RECONCILIACAO_DIVERGENCIA', 'lotes', {
        detalhe: `${divergencias.length} divergência(s) encontrada(s) na reconciliação`,
      });
    }

    return {
      executadoEm: window.CH.Utils.nowISO(),
      totalDivergencias: divergencias.length,
      porSeveridade: {
        alta:  divergencias.filter(d => d.severidade === 'alta').length,
        media: divergencias.filter(d => d.severidade === 'media').length,
        baixa: divergencias.filter(d => d.severidade === 'baixa').length,
      },
      divergencias,
    };
  }

  window.CH = window.CH || {};
  window.CH.ReconciliationService = { verificarConsistencia, executarReconciliacao };
  console.info('%c reconciliationService ✓', 'color:#64748b');
})();
