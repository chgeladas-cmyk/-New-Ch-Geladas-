'use strict';
/**
 * services/custoService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Precisão monetária centralizada + cálculo de "custo real" de uma
 * compra (mercadoria + frete + despesas - desconto).
 *
 * ESTRATÉGIA DE PRECISÃO (Seção 30 do documento de rastreabilidade):
 *   - Valores monetários "de fechamento" (custoTotalReal, receita, CMV
 *     final de uma venda) são sempre arredondados para 2 casas decimais
 *     (centavos) — é o que aparece pro usuário e o que soma/bate com o
 *     caixa físico.
 *   - custoUnitario (R$/unidade dentro de um lote) é mantido com 6 casas
 *     decimais internamente. Arredondar isso pra 2 casas na hora de
 *     gravar o lote causaria erro acumulado: um lote de 2,5kg por
 *     R$ 33,33 tem custoUnitario = 13,332 R$/kg — arredondar pra 13,33
 *     e multiplicar de volta por 2,5kg dá R$ 33,325 (≠ R$ 33,33 original,
 *     diferença que se acumula a cada venda parcial do mesmo lote).
 *   - CMV de uma venda: soma as parcelas de CADA lote consumido usando o
 *     custoUnitario de alta precisão, e só arredonda pra 2 casas o TOTAL
 *     final — nunca cada parcela isolada antes de somar.
 *
 * Requer: core.js carregado antes.
 */

(function () {
  const PRECISAO_UNITARIA = 6; // casas decimais para custoUnitario interno

  /** Arredonda pra N casas decimais evitando artefatos de ponto flutuante
   *  (0.1+0.2 etc). Usa a técnica de somar Number.EPSILON antes de arredondar. */
  function arredondar(valor, casas = 2) {
    const num = Number(valor) || 0;
    const fator = 10 ** casas;
    return Math.round((num + Number.EPSILON) * fator) / fator;
  }

  /** Arredonda para centavos (2 casas) — uso em qualquer valor "final" exibido/somado ao caixa */
  function paraCentavos(valorReais) { return arredondar(valorReais, 2); }

  /** Custo unitário de alta precisão — uso interno em lotes, nunca exibir direto sem arredondar na hora de mostrar */
  function custoUnitarioPreciso(custoTotalReal, quantidadeInicial) {
    if (!quantidadeInicial || quantidadeInicial <= 0) return 0;
    return arredondar(custoTotalReal / quantidadeInicial, PRECISAO_UNITARIA);
  }

  /**
   * Custo real de uma compra: mercadoria + frete + outras despesas - desconto.
   * Todas as parcelas são arredondadas pra centavos individualmente (são
   * valores "de nota fiscal", não frações de unidade — não tem o mesmo
   * problema de acumulação que custoUnitario tem).
   */
  function calcularCustoReal({ custoMercadoria = 0, frete = 0, desconto = 0, outrasDespesas = 0 } = {}) {
    const cm = paraCentavos(custoMercadoria);
    const fr = paraCentavos(frete);
    const de = paraCentavos(desconto);
    const od = paraCentavos(outrasDespesas);
    const custoTotalReal = paraCentavos(cm + fr - de + od);
    if (custoTotalReal < 0) {
      throw new Error('Custo real não pode ser negativo (desconto maior que mercadoria+frete+despesas).');
    }
    return { custoMercadoria: cm, frete: fr, desconto: de, outrasDespesas: od, custoTotalReal };
  }

  /**
   * CMV de uma venda que consome um ou mais lotes (FIFO).
   * `parcelas` = [{ loteId, quantidade, custoUnitario }, ...] (custoUnitario
   * de alta precisão, como vem de CompraLote.custoUnitario).
   * Retorna o CMV total já arredondado pra centavos, MAIS o detalhe de
   * cada parcela (arredondada só para exibição/auditoria — a soma usada
   * como CMV real é sempre a soma dos valores não-arredondados).
   */
  function calcularCMV(parcelas) {
    if (!Array.isArray(parcelas) || !parcelas.length) return { cmvTotal: 0, detalhe: [] };
    let somaPrecisa = 0;
    const detalhe = parcelas.map(p => {
      const valorPreciso = (p.quantidade || 0) * (p.custoUnitario || 0);
      somaPrecisa += valorPreciso;
      return {
        loteId:        p.loteId,
        quantidade:    p.quantidade,
        custoUnitario: p.custoUnitario,
        custoParcela:  paraCentavos(valorPreciso), // só para exibição/auditoria
      };
    });
    return { cmvTotal: paraCentavos(somaPrecisa), detalhe };
  }

  /** Margem bruta (%) = lucro / receita × 100. Retorna 0 se receita for 0 (evita divisão por zero / Infinity). */
  function calcularMargem(lucroBruto, receitaLiquida) {
    if (!receitaLiquida) return 0;
    return arredondar((lucroBruto / receitaLiquida) * 100, 2);
  }

  /** ROI (%) = lucro / investimento × 100. Retorna 0 se investimento for 0. */
  function calcularROI(lucroRealizado, investimentoRealizado) {
    if (!investimentoRealizado) return 0;
    return arredondar((lucroRealizado / investimentoRealizado) * 100, 2);
  }

  /**
   * Conversão entre unidades de medida (Seção 31). Cobre massa (KG/G) e
   * volume (L/ML) — conversões "métricas" de verdade, com fator fixo.
   *
   * CX/FD/PACOTE (fardo, caixa, pacote) NÃO entram aqui de propósito: são
   * "packs" com multiplicador PRÓPRIO DE CADA PRODUTO (ex.: "Fardo 12x"
   * pode ser 12 ou 24 dependendo do produto) — isso já é resolvido pelo
   * mecanismo `produto.packs` existente em vendas.html/estoqueService,
   * não por um fator fixo global. Tentar unificar os dois sistemas
   * causaria mais confusão do que resolveria.
   */
  const GRANDEZAS = {
    KG: { grandeza: 'massa',    fatorBase: 1 },
    G:  { grandeza: 'massa',    fatorBase: 0.001 },
    L:  { grandeza: 'volume',   fatorBase: 1 },
    ML: { grandeza: 'volume',   fatorBase: 0.001 },
    UN: { grandeza: 'contagem', fatorBase: 1 },
  };

  /** true se as duas unidades são da mesma grandeza (dá pra converter uma na outra). */
  function unidadesCompativeis(u1, u2) {
    return !!(GRANDEZAS[u1] && GRANDEZAS[u2] && GRANDEZAS[u1].grandeza === GRANDEZAS[u2].grandeza);
  }

  /**
   * Converte `quantidade` de `deUnidade` para `paraUnidade`. Lança erro se
   * as unidades forem de grandezas diferentes (ex.: KG→L) ou desconhecidas
   * — nunca converte "no chute" ou ignora silenciosamente (Seção 29:
   * nunca deixar o sistema seguir em frente calado diante de um problema).
   */
  function converterQuantidade(quantidade, deUnidade, paraUnidade) {
    if (deUnidade === paraUnidade) return quantidade;
    const de = GRANDEZAS[deUnidade], para = GRANDEZAS[paraUnidade];
    if (!de)   throw new Error(`Unidade de medida desconhecida: ${deUnidade}`);
    if (!para) throw new Error(`Unidade de medida desconhecida: ${paraUnidade}`);
    if (de.grandeza !== para.grandeza) {
      throw new Error(`Não é possível converter ${deUnidade} para ${paraUnidade} — grandezas incompatíveis (${de.grandeza} × ${para.grandeza}).`);
    }
    return quantidade * de.fatorBase / para.fatorBase;
  }

  window.CH = window.CH || {};
  window.CH.CustoService = {
    arredondar, paraCentavos, custoUnitarioPreciso,
    calcularCustoReal, calcularCMV, calcularMargem, calcularROI,
    unidadesCompativeis, converterQuantidade,
  };
  console.info('%c custoService ✓', 'color:#64748b');
})();
