'use strict';
/**
 * services/biService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Motor de Business Intelligence & Analytics.
 *
 * APIs disponíveis:
 *
 *  getCurvaABC(dias?)           → Curva ABC de produtos por faturamento
 *  getTicketMedio(de, ate)      → Ticket médio e distribuição
 *  getCMV(de, ate)              → Custo de Mercadoria Vendida
 *  getLucroPorCategoria(de,ate) → Lucro e margem por categoria
 *  getMargemReal(de, ate)       → Margem bruta real
 *  getProdutosParados(dias)     → Produtos sem venda há X dias
 *  getHorariosPico(de, ate)     → Distribuição de vendas por hora
 *  getRankingProdutos(lim, de, ate) → Ranking por receita/qtd
 *  getDashboardExecutivo()      → KPIs consolidados para o dashboard
 *  getFluxoCaixaPeriodo(de,ate) → Fluxo de caixa dia a dia
 *  getComparativoPeriodos()     → Comparativo mês atual vs anterior
 *
 * Requer: core.js + vendasService + estoqueService + financeiroService
 */

(function () {
  const { Store, Utils } = window.CH;

  // Cache do histórico COMPLETO de vendas, buscado direto do Firestore
  // (sem o cap de 1000 do onSnapshot em core.js). null até a primeira busca
  // terminar; enquanto isso, os helpers abaixo caem no Store.getVendas()
  // normal (mesmo comportamento de antes, sem regressão).
  // BUG CORRIGIDO: Curva ABC, CMV, ranking de produtos, ticket médio etc.
  // somavam só as 1000 vendas mais recentes do cache local, subestimando
  // os resultados em negócios de alto volume (mesma causa raiz do bug do
  // Financeiro: R$13k exibido vs R$50k+ real).
  let _vendasFullCache = null;

  // Busca o histórico completo uma vez e guarda em cache neste módulo.
  // Deve ser chamada pela tela (ex.: bi-dashboard.html) ao carregar, antes
  // de chamar os getters de KPI, para garantir números corretos.
  async function carregarHistoricoCompleto() {
    if (!window.CH?.FirebaseService?.lerVendasCompleto) return null; // fallback seguro
    try {
      _vendasFullCache = await window.CH.FirebaseService.lerVendasCompleto();
      return _vendasFullCache;
    } catch (e) {
      console.warn('[BIService] Falha ao buscar histórico completo, usando cache local (pode estar incompleto):', e.message);
      return null;
    }
  }

  function _todasVendas() {
    return _vendasFullCache || Store.getVendas() || [];
  }

  // ── Helpers internos ──────────────────────────────────────────────

  function _vendasPeriodo(de, ate, { incluirCambio = false } = {}) {
    const vendas = _todasVendas();
    const STATUS_VALIDOS = ['concluida', 'validada', 'aprovada'];
    return vendas.filter(v =>
      STATUS_VALIDOS.includes(v.status || 'concluida') &&
      (!de  || v.dataCurta >= de) &&
      (!ate || v.dataCurta <= ate) &&
      // Câmbios NÃO são vendas de produto — excluir dos KPIs de receita/CMV/ABC
      // a menos que explicitamente solicitado
      (incluirCambio || !v._cambio)
    );
  }

  // Retorna apenas os câmbios do período (para o gráfico de formas de pagamento)
  function _cambiosPeriodo(de, ate) {
    const vendas = _todasVendas();
    return vendas.filter(v =>
      v._cambio &&
      ['concluida','validada'].includes(v.status || 'concluida') &&
      (!de  || v.dataCurta >= de) &&
      (!ate || v.dataCurta <= ate)
    );
  }

  function _localDateISO(date) {
    // Replica a função homônima do core.js (não acessível fora do IIFE de lá)
    const offset = date.getTimezoneOffset();
    const local  = new Date(date.getTime() - offset * 60000);
    return local.toISOString().slice(0, 10);
  }

  function _diasAtras(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return _localDateISO(d);
  }

  function _mesAtual() {
    const n = new Date();
    return {
      de:  `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-01`,
      ate: Utils.todayISO(),
    };
  }

  function _mesAnterior() {
    const n = new Date();
    const m = n.getMonth(); // 0-based
    const y = m === 0 ? n.getFullYear() - 1 : n.getFullYear();
    const mes = m === 0 ? 12 : m;
    const ultimo = new Date(y, mes, 0).getDate();
    return {
      de:  `${y}-${String(mes).padStart(2, '0')}-01`,
      ate: `${y}-${String(mes).padStart(2, '0')}-${ultimo}`,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CURVA ABC
  //  Classifica produtos por participação acumulada no faturamento:
  //    A → primeiros 70% do faturamento  (itens mais valiosos)
  //    B → próximos 20%                 (importância intermediária)
  //    C → últimos 10%                  (baixa representatividade)
  // ══════════════════════════════════════════════════════════════════
  function getCurvaABC(de, ate) {
    // Compat retroativa: se vier um número, trata como "dias atrás" (comportamento antigo).
    let dias;
    if (typeof de === 'number' || de === undefined) {
      dias = de || 90;
      de  = _diasAtras(dias);
      ate = Utils.todayISO();
    }
    const vendas = _vendasPeriodo(de, ate);

    // Agrupa por produto
    const mapa = {};
    let totalGeral = 0;

    vendas.forEach(venda => {
      // Câmbio, lançamentos manuais de fiado e vendas avulsas (descrição livre)
      // não são produtos de estoque — contaminariam o ranking de produtos.
      if (venda._cambio || venda._fiado || venda._avulsa) return;
      (venda.itens || []).forEach(item => {
        const id = item.prodId || item.id;
        if (!mapa[id]) {
          mapa[id] = {
            id,
            nome:      item.nome || 'Desconhecido',
            categoria: item.categoria || '',
            qtd:       0,
            receita:   0,
            custo:     0,
            lucro:     0,
          };
        }
        // BLINDAGEM: item sem qtd/preço válido (ex: "Taxa de entrega" sem preço,
        // item corrompido) não pode virar NaN e contaminar o totalGeral —
        // um único NaN aqui zera o percentual de TODOS os produtos da curva.
        const qtd    = Number(item.qtd) || 0;
        const custo  = (Number(item.custo) || Number(item.custoUn) || 0) * qtd;
        const receita = (Number(item.preco) || Number(item.precoUn) || 0) * qtd;
        mapa[id].qtd     += qtd;
        mapa[id].receita += receita;
        mapa[id].custo   += custo;
        mapa[id].lucro   += receita - custo;
        totalGeral        += receita;
      });
    });

    const lista = Object.values(mapa)
      .sort((a, b) => b.receita - a.receita);

    // Calcula % e acumulado
    let acum = 0;
    lista.forEach(item => {
      item.percentual  = totalGeral > 0 ? (item.receita / totalGeral) * 100 : 0;
      acum            += item.percentual;
      item.acumulado   = acum;
      item.margem      = item.receita > 0 ? (item.lucro / item.receita) * 100 : 0;
      // Classificação ABC
      if (acum - item.percentual < 70)      item.classe = 'A';
      else if (acum - item.percentual < 90) item.classe = 'B';
      else                                  item.classe = 'C';
    });

    const resumo = {
      A: { count: 0, receita: 0, percentualReceita: 0 },
      B: { count: 0, receita: 0, percentualReceita: 0 },
      C: { count: 0, receita: 0, percentualReceita: 0 },
    };
    lista.forEach(p => {
      resumo[p.classe].count++;
      resumo[p.classe].receita += p.receita;
    });
    ['A', 'B', 'C'].forEach(cls => {
      resumo[cls].percentualReceita = totalGeral > 0
        ? (resumo[cls].receita / totalGeral) * 100 : 0;
    });

    return { lista, totalGeral, resumo, periodo: { de, ate, dias } };
  }

  // ══════════════════════════════════════════════════════════════════
  //  TICKET MÉDIO
  // ══════════════════════════════════════════════════════════════════
  function getTicketMedio(de, ate) {
    if (!de || !ate) { const m = _mesAtual(); de = m.de; ate = m.ate; }
    const vendas = _vendasPeriodo(de, ate);
    if (!vendas.length) return { ticketMedio: 0, total: 0, qtdVendas: 0, distribuicao: [] };

    const total = vendas.reduce((s, v) => s + (v.total || 0), 0);
    const ticket = total / vendas.length;

    // Distribuição por faixas de ticket (histograma)
    const faixas = [
      { label: 'até R$20',     min: 0,   max: 20   },
      { label: 'R$20–50',      min: 20,  max: 50   },
      { label: 'R$50–100',     min: 50,  max: 100  },
      { label: 'R$100–200',    min: 100, max: 200  },
      { label: 'acima R$200',  min: 200, max: Infinity },
    ];
    const dist = faixas.map(f => ({
      ...f,
      qtd:        vendas.filter(v => v.total >= f.min && v.total < f.max).length,
      percentual: 0,
    }));
    dist.forEach(f => { f.percentual = (f.qtd / vendas.length) * 100; });

    // Por forma de pagamento — separa misto nas parcelas reais
    const porForma = {};
    vendas.forEach(v => {
      const f = v.formaPgto || 'Outros';
      if (f.startsWith('Dinheiro+') && v._parcelaDinheiro > 0) {
        const f2 = v._formaRestante || f.replace('Dinheiro+', '');
        if (!porForma['Dinheiro']) porForma['Dinheiro'] = { qtd: 0, total: 0 };
        if (!porForma[f2])         porForma[f2]         = { qtd: 0, total: 0 };
        porForma['Dinheiro'].total += v._parcelaDinheiro;
        porForma[f2].total         += v._parcelaRestante || 0;
        porForma['Dinheiro'].qtd++;
        porForma[f2].qtd++;
      } else {
        if (!porForma[f]) porForma[f] = { qtd: 0, total: 0 };
        porForma[f].qtd++;
        porForma[f].total += v.total || 0;
      }
    });
    Object.values(porForma).forEach(f => { f.ticket = f.qtd > 0 ? f.total / f.qtd : 0; });

    return { ticketMedio: ticket, total, qtdVendas: vendas.length, distribuicao: dist, porForma };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CMV — Custo de Mercadoria Vendida
  //  CMV = Σ (custo_unitário × qtd_vendida) por período
  //  Margem bruta = Receita - CMV
  // ══════════════════════════════════════════════════════════════════
  function getCMV(de, ate) {
    if (!de || !ate) { const m = _mesAtual(); de = m.de; ate = m.ate; }
    const vendas = _vendasPeriodo(de, ate);

    let receita = 0, cmv = 0;

    vendas.forEach(v => {
      receita += v.total || 0;
      (v.itens || []).forEach(item => {
        const custo = (item.custo || item.custoUn || 0);
        cmv += custo * (item.qtd || 0);
      });
    });

    const margemBruta = receita - cmv;
    const percentualCMV = receita > 0 ? (cmv / receita) * 100 : 0;
    const margemPercentual = receita > 0 ? (margemBruta / receita) * 100 : 0;

    // Alertas
    const alertas = [];
    if (percentualCMV > 65) alertas.push({ tipo: 'critical', msg: `CMV em ${percentualCMV.toFixed(1)}% — muito alto! Revise custos ou preços.` });
    else if (percentualCMV > 50) alertas.push({ tipo: 'warning', msg: `CMV em ${percentualCMV.toFixed(1)}% — atenção à margem.` });

    return { receita, cmv, margemBruta, percentualCMV, margemPercentual, qtdVendas: vendas.length, alertas, periodo: { de, ate } };
  }

  // ══════════════════════════════════════════════════════════════════
  //  LUCRO E MARGEM POR CATEGORIA
  // ══════════════════════════════════════════════════════════════════
  function getLucroPorCategoria(de, ate) {
    if (!de || !ate) { const m = _mesAtual(); de = m.de; ate = m.ate; }
    const vendas = _vendasPeriodo(de, ate);

    const mapa = {};
    vendas.forEach(v => {
      (v.itens || []).forEach(item => {
        const cat = item.categoria || 'Sem Categoria';
        if (!mapa[cat]) mapa[cat] = { categoria: cat, receita: 0, custo: 0, lucro: 0, qtd: 0 };
        const receita = (item.preco || 0) * (item.qtd || 0);
        const custo   = (item.custo || item.custoUn || 0) * (item.qtd || 0);
        mapa[cat].receita += receita;
        mapa[cat].custo   += custo;
        mapa[cat].lucro   += receita - custo;
        mapa[cat].qtd     += item.qtd || 0;
      });
    });

    const lista = Object.values(mapa)
      .sort((a, b) => b.lucro - a.lucro)
      .map(c => ({
        ...c,
        margem: c.receita > 0 ? (c.lucro / c.receita) * 100 : 0,
      }));

    const totalReceita = lista.reduce((s, c) => s + c.receita, 0);
    lista.forEach(c => {
      c.participacao = totalReceita > 0 ? (c.receita / totalReceita) * 100 : 0;
    });

    return { lista, totalReceita, periodo: { de, ate } };
  }

  // ══════════════════════════════════════════════════════════════════
  //  MARGEM REAL
  // ══════════════════════════════════════════════════════════════════
  function getMargemReal(de, ate) {
    if (!de || !ate) { const m = _mesAtual(); de = m.de; ate = m.ate; }
    const cmv = getCMV(de, ate);
    return {
      ...cmv,
      margemReal: cmv.margemPercentual,
      avaliacao: cmv.margemPercentual >= 40 ? 'excelente'
               : cmv.margemPercentual >= 25 ? 'boa'
               : cmv.margemPercentual >= 15 ? 'regular'
               : 'critica',
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  PRODUTOS PARADOS
  //  Produtos com estoque > 0 que não venderam há X dias
  // ══════════════════════════════════════════════════════════════════
  function getProdutosParados(dias = 30) {
    const ate = Utils.todayISO();
    const de  = _diasAtras(dias);

    // Produtos que venderam no período
    const vendeUltimosPeriodo = new Set(
      _vendasPeriodo(de, ate)
        .flatMap(v => (v.itens || []).map(i => i.prodId || i.id))
    );

    const estoque = Store.getEstoque() || [];
    const parados = estoque
      .filter(p => p.ativo !== false && (p.qtdUn || p.estoqueAtual || 0) > 0)
      .filter(p => !vendeUltimosPeriodo.has(p.id))
      .map(p => {
        // Última venda desse produto (em todo o histórico)
        const todasVendas = _todasVendas().filter(v =>
          ['concluida', 'validada'].includes(v.status) &&
          (v.itens || []).some(i => (i.prodId || i.id) === p.id)
        );
        const ultimaVenda = todasVendas.length
          ? todasVendas.sort((a, b) => b.dataCurta.localeCompare(a.dataCurta))[0]?.dataCurta
          : null;

        const diasParado = ultimaVenda
          ? Math.floor((new Date(ate) - new Date(ultimaVenda)) / 86400000)
          : null;

        const custoEstoque = (p.precoCusto || p.custoUn || 0) * (p.qtdUn || p.estoqueAtual || 0);

        return {
          id:           p.id,
          nome:         p.nome,
          categoria:    p.categoria || '',
          qtdEstoque:   p.qtdUn || p.estoqueAtual || 0,
          custoEstoque,
          ultimaVenda,
          diasParado,
          gravidade:    diasParado === null ? 'nunca_vendeu'
                      : diasParado > 90    ? 'critico'
                      : diasParado > 60    ? 'alto'
                      : 'moderado',
        };
      })
      .sort((a, b) => (b.diasParado || 9999) - (a.diasParado || 9999));

    const capitalParado = parados.reduce((s, p) => s + p.custoEstoque, 0);
    return { lista: parados, total: parados.length, capitalParado, periodo: dias };
  }

  // ══════════════════════════════════════════════════════════════════
  //  HORÁRIOS DE PICO
  // ══════════════════════════════════════════════════════════════════
  function getHorariosPico(de, ate) {
    if (!de || !ate) { const m = _mesAtual(); de = m.de; ate = m.ate; }
    const vendas = _vendasPeriodo(de, ate);

    // Inicializa todos os slots de hora
    const porHora = Array.from({ length: 24 }, (_, h) => ({
      hora:       h,
      label:      `${String(h).padStart(2, '0')}h`,
      qtdVendas:  0,
      total:      0,
      ticketMedio:0,
    }));

    // Distribuição por dia da semana
    const porDiaSemana = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
      .map((label, dia) => ({ dia, label, qtdVendas: 0, total: 0 }));

    vendas.forEach(v => {
      // Hora
      let hora = null;
      if (v.hora) {
        hora = parseInt(v.hora.slice(0, 2), 10);
      } else if (v.criadoEm) {
        hora = new Date(v.criadoEm).getHours();
      }
      if (hora !== null && hora >= 0 && hora < 24) {
        porHora[hora].qtdVendas++;
        porHora[hora].total += v.total || 0;
      }

      // Dia da semana
      if (v.dataCurta) {
        const dow = new Date(v.dataCurta + 'T12:00:00').getDay();
        porDiaSemana[dow].qtdVendas++;
        porDiaSemana[dow].total += v.total || 0;
      }
    });

    porHora.forEach(h => {
      h.ticketMedio = h.qtdVendas > 0 ? h.total / h.qtdVendas : 0;
    });

    // Identifica picos (top 3 horas)
    const picos = [...porHora]
      .sort((a, b) => b.qtdVendas - a.qtdVendas)
      .slice(0, 3)
      .map(h => h.hora);

    return { porHora, porDiaSemana, picos, totalVendas: vendas.length };
  }

  // ══════════════════════════════════════════════════════════════════
  //  RANKING DE PRODUTOS
  // ══════════════════════════════════════════════════════════════════
  function getRankingProdutos(limite = 15, de, ate) {
    if (!de || !ate) { const m = _mesAtual(); de = m.de; ate = m.ate; }
    const vendas = _vendasPeriodo(de, ate);

    const mapa = {};
    vendas.forEach(v => {
      (v.itens || []).forEach(item => {
        const id = item.prodId || item.id;
        if (!mapa[id]) {
          mapa[id] = {
            id,
            nome:      item.nome || 'Desconhecido',
            categoria: item.categoria || '',
            qtd:       0,
            receita:   0,
            custo:     0,
            lucro:     0,
            qtdVendas: 0,
          };
        }
        mapa[id].qtd      += item.qtd || 0;
        mapa[id].receita  += (item.preco || 0) * (item.qtd || 0);
        mapa[id].custo    += (item.custo || item.custoUn || 0) * (item.qtd || 0);
        mapa[id].lucro    += ((item.preco || 0) - (item.custo || item.custoUn || 0)) * (item.qtd || 0);
        mapa[id].qtdVendas++;
      });
    });

    const lista = Object.values(mapa)
      .map(p => ({
        ...p,
        margem: p.receita > 0 ? (p.lucro / p.receita) * 100 : 0,
      }));

    return {
      porReceita: [...lista].sort((a, b) => b.receita - a.receita).slice(0, limite),
      porQtd:     [...lista].sort((a, b) => b.qtd - a.qtd).slice(0, limite),
      porLucro:   [...lista].sort((a, b) => b.lucro - a.lucro).slice(0, limite),
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  FLUXO DE CAIXA PERÍODO
  // ══════════════════════════════════════════════════════════════════
  function getFluxoCaixaPeriodo(de, ate) {
    if (!de || !ate) { const m = _mesAtual(); de = m.de; ate = m.ate; }

    const FinSvc = window.CH?.FinanceiroService;
    if (FinSvc?.getFluxoCaixa) return FinSvc.getFluxoCaixa(de, ate);

    // Fallback: calcula direto das vendas
    const vendas = _vendasPeriodo(de, ate);
    const dias = {};
    vendas.forEach(v => {
      if (!dias[v.dataCurta]) dias[v.dataCurta] = { data: v.dataCurta, receitas: 0, qtd: 0 };
      dias[v.dataCurta].receitas += v.total || 0;
      dias[v.dataCurta].qtd++;
    });
    return Object.values(dias).sort((a, b) => a.data.localeCompare(b.data));
  }

  // ══════════════════════════════════════════════════════════════════
  //  COMPARATIVO PERÍODO ATUAL × ANTERIOR
  // ══════════════════════════════════════════════════════════════════
  // Dado um período [de, ate], devolve o período imediatamente anterior
  // com a mesma quantidade de dias — usado para comparar "período vs anterior"
  // quando o usuário escolhe um intervalo customizado no filtro do dashboard.
  function _periodoAnteriorEquivalente(de, ate) {
    const dIni = new Date(de + 'T00:00:00');
    const dFim = new Date(ate + 'T00:00:00');
    const qtdDias = Math.max(1, Math.round((dFim - dIni) / 86400000) + 1);
    const antFim = new Date(dIni);
    antFim.setDate(antFim.getDate() - 1);
    const antIni = new Date(antFim);
    antIni.setDate(antIni.getDate() - (qtdDias - 1));
    return { de: _localDateISO(antIni), ate: _localDateISO(antFim) };
  }

  function getComparativoPeriodos(de, ate) {
    const atual    = (de && ate) ? { de, ate } : _mesAtual();
    const anterior = (de && ate) ? _periodoAnteriorEquivalente(de, ate) : _mesAnterior();

    const vAtual    = _vendasPeriodo(atual.de, atual.ate);
    const vAnterior = _vendasPeriodo(anterior.de, anterior.ate);

    function _resumir(vendas) {
      const receita = vendas.reduce((s, v) => s + (v.total || 0), 0);
      const lucro   = vendas.reduce((s, v) => s + (v.lucro  || 0), 0);
      return {
        qtd:    vendas.length,
        receita,
        lucro,
        ticket: vendas.length ? receita / vendas.length : 0,
        margem: receita > 0 ? (lucro / receita) * 100 : 0,
      };
    }

    const ra = _resumir(vAtual);
    const rp = _resumir(vAnterior);

    function _variacao(a, p) {
      if (!p) return null;
      return ((a - p) / p) * 100;
    }

    return {
      atual:    { ...ra, periodo: atual },
      anterior: { ...rp, periodo: anterior },
      variacao: {
        receita: _variacao(ra.receita, rp.receita),
        lucro:   _variacao(ra.lucro,   rp.lucro),
        qtd:     _variacao(ra.qtd,     rp.qtd),
        ticket:  _variacao(ra.ticket,  rp.ticket),
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  DASHBOARD EXECUTIVO — KPIs CONSOLIDADOS
  // ══════════════════════════════════════════════════════════════════
  function getDashboardExecutivo(de, ate) {
    const hoje = Utils.todayISO();
    // Sem período informado: cai no comportamento antigo (mês calendário).
    if (!de || !ate) { const m = _mesAtual(); de = m.de; ate = m.ate; }
    const periodo_de = de, periodo_ate = ate;

    // Vendas hoje
    const vendasHoje = _vendasPeriodo(hoje, hoje);
    const totalHoje  = vendasHoje.reduce((s, v) => s + (v.total || 0), 0);
    const lucroHoje  = vendasHoje.reduce((s, v) => s + (v.lucro  || 0), 0);

    // Período selecionado no filtro do dashboard (antes era sempre "mês calendário")
    const vendasMes  = _vendasPeriodo(periodo_de, periodo_ate);
    const totalMes   = vendasMes.reduce((s, v) => s + (v.total || 0), 0);
    const lucroMes   = vendasMes.reduce((s, v) => s + (v.lucro  || 0), 0);

    // CMV e margem — MESMO período selecionado (antes eram sempre os últimos
    // 30 dias fixos, o que gerava % absurdas ao comparar com a receita do
    // período escolhido, ex: CMV de 30 dias ÷ receita de 2 dias = 3800%).
    const cmv30 = getCMV(periodo_de, periodo_ate);

    // ── Qualidade dos dados de custo ──────────────────────────────
    const todasVendas30 = vendasMes;
    const vendasSemCusto = todasVendas30.filter(v => v._custoIncompleto).length;
    const pctSemCusto = todasVendas30.length > 0
      ? (vendasSemCusto / todasVendas30.length) * 100 : 0;
    const custoDadosConfiavel = pctSemCusto < 10; // < 10% das vendas sem custo = ok

    // Curva ABC — MESMO período selecionado (antes eram sempre 90 dias fixos,
    // por isso o filtro do dashboard não tinha efeito nenhum na aba Curva ABC).
    const abc = getCurvaABC(periodo_de, periodo_ate);

    // Produtos parados — alerta independente do filtro (sempre últimos 30 dias)
    const parados = getProdutosParados(30);

    // Ticket médio — mesmo período selecionado
    const ticket = getTicketMedio(periodo_de, periodo_ate);

    // Comparativo — período selecionado vs período anterior equivalente
    const comparativo = getComparativoPeriodos(periodo_de, periodo_ate);

    // Estoque
    const estoque = Store.getEstoque() || [];
    const produtosAtivos = estoque.filter(p => p.ativo !== false);
    const estoqueBaixo   = produtosAtivos.filter(p =>
      (p.qtdUn || p.estoqueAtual || 0) <= (p.estoqueMinimo || 3)
    );
    const estoqueZerado  = produtosAtivos.filter(p =>
      (p.qtdUn || p.estoqueAtual || 0) <= 0
    );

    return {
      hoje: {
        vendas:  vendasHoje.length,
        receita: totalHoje,
        lucro:   lucroHoje,
        margem:  totalHoje > 0 ? (lucroHoje / totalHoje) * 100 : 0,
        ticket:  vendasHoje.length ? totalHoje / vendasHoje.length : 0,
      },
      mes: {
        vendas:  vendasMes.length,
        receita: totalMes,
        lucro:   lucroMes,
        cmv:     cmv30.cmv,
        margem:  cmv30.margemPercentual,
      },
      comparativo,
      abc: {
        produtosA: abc.resumo.A.count,
        receitaA:  abc.resumo.A.receita,
        percentualA: abc.resumo.A.percentualReceita,
      },
      estoque: {
        total:   produtosAtivos.length,
        baixo:   estoqueBaixo.length,
        zerado:  estoqueZerado.length,
        produtosBaixo: estoqueBaixo.map(p => ({ id: p.id, nome: p.nome, qtd: p.qtdUn || p.estoqueAtual || 0 })),
      },
      financeiro: {
        ticketMedio:    ticket.ticketMedio,
        margemReal:     cmv30.margemPercentual,
        capitalParado:  parados.capitalParado,
        produtosParados:parados.total,
      },
      qualidadeDados: {
        custoDadosConfiavel,
        pctVendasSemCusto: Math.round(pctSemCusto),
        vendasSemCusto,
        aviso: !custoDadosConfiavel
          ? `⚠️ ${Math.round(pctSemCusto)}% das vendas (30d) têm produtos sem custo — CMV e margem podem estar incorretos`
          : null,
      },
      alertas: _gerarAlertas({ cmv30, estoqueBaixo, estoqueZerado, parados, pctSemCusto }),
    };
  }

  // ── Alertas inteligentes ──────────────────────────────────────────
  function _gerarAlertas({ cmv30, estoqueBaixo, estoqueZerado, parados, pctSemCusto = 0 }) {
    const alertas = [];

    if (estoqueZerado.length > 0)
      alertas.push({ tipo: 'critical', icone: '🚨', msg: `${estoqueZerado.length} produto(s) com estoque ZERADO` });
    if (estoqueBaixo.length > 3)
      alertas.push({ tipo: 'warning', icone: '⚠️', msg: `${estoqueBaixo.length} produto(s) com estoque baixo` });
    if (cmv30.percentualCMV > 65)
      alertas.push({ tipo: 'critical', icone: '💸', msg: `CMV alto: ${cmv30.percentualCMV.toFixed(1)}% — margem comprometida` });
    if (parados.total > 5)
      alertas.push({ tipo: 'info', icone: '📦', msg: `${parados.total} produto(s) sem venda há 30+ dias (capital parado: ${Utils.formatCurrency(parados.capitalParado)})` });
    // ── Alerta de qualidade de dados ────────────────────────────────
    if (pctSemCusto >= 30)
      alertas.push({ tipo: 'critical', icone: '📊', msg: `${Math.round(pctSemCusto)}% das vendas não têm custo cadastrado — CMV e margem estão INCORRETOS. Cadastre o preço de custo nos produtos.` });
    else if (pctSemCusto >= 10)
      alertas.push({ tipo: 'warning', icone: '📊', msg: `${Math.round(pctSemCusto)}% das vendas sem custo — BI pode estar subestimando o CMV.` });

    return alertas;
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOS CONSOLIDADOS
  //  Soma TODOS os custos do período:
  //    CMV            = custo dos itens vendidos (do cadastro de produtos)
  //    Despesas Op.   = lançamentos tipo 'despesa' no FinanceiroService
  //    Custo Total    = CMV + Despesas Op.
  //    Resultado Liq. = Receita − Custo Total
  // ══════════════════════════════════════════════════════════════════
  function getCustosConsolidados(de, ate) {
    if (!de || !ate) { const m = _mesAtual(); de = m.de; ate = m.ate; }

    // ── CMV das vendas ────────────────────────────────────────────
    const cmvData = getCMV(de, ate);

    // ── Despesas operacionais registradas ─────────────────────────
    const FinSvc   = window.CH?.FinanceiroService;
    const despesas = FinSvc
      ? (FinSvc.getLancamentos({ tipo: 'despesa', dataDe: de, dataAte: ate }) || [])
      : [];

    // Agrupamento por categoria
    const mapaCat = {};
    despesas.forEach(d => {
      const cat = d.categoria || 'outro';
      if (!mapaCat[cat]) mapaCat[cat] = { categoria: cat, valor: 0, count: 0 };
      mapaCat[cat].valor += d.valor || 0;
      mapaCat[cat].count++;
    });

    const LABEL_CAT = {
      compra:       'Compras / Estoque',
      avaria:       'Avarias',
      ajuste:       'Ajustes',
      operacional:  'Operacional',
      cancelamento: 'Cancelamentos',
      outro:        'Outros',
    };

    const totalDespesas   = despesas.reduce((s, d) => s + (d.valor || 0), 0);
    const totalCustos     = cmvData.cmv + totalDespesas;
    const resultadoLiq    = cmvData.receita - totalCustos;
    const margemLiquida   = cmvData.receita > 0 ? (resultadoLiq / cmvData.receita) * 100 : 0;
    const pctDespesas     = cmvData.receita > 0 ? (totalDespesas / cmvData.receita) * 100 : 0;
    const pctCustoTotal   = cmvData.receita > 0 ? (totalCustos   / cmvData.receita) * 100 : 0;

    const listaCategorias = Object.values(mapaCat)
      .sort((a, b) => b.valor - a.valor)
      .map(c => ({
        ...c,
        label:      LABEL_CAT[c.categoria] || c.categoria,
        percentual: totalDespesas > 0 ? (c.valor / totalDespesas) * 100 : 0,
      }));

    // ── Fluxo dia a dia: receita / custo_mercadoria / despesas ────
    // (para gráfico de linha do período)
    const fluxoDias = {};
    // preenche receita das vendas
    _vendasPeriodo(de, ate).forEach(v => {
      const d = v.dataCurta;
      if (!fluxoDias[d]) fluxoDias[d] = { data: d, receita: 0, cmv: 0, despesas: 0 };
      fluxoDias[d].receita += v.total || 0;
      (v.itens || []).forEach(item => {
        fluxoDias[d].cmv += (item.custo || item.custoUn || 0) * (item.qtd || 0);
      });
    });
    // preenche despesas operacionais por dia
    despesas.forEach(d => {
      const dt = d.dataCurta;
      if (!fluxoDias[dt]) fluxoDias[dt] = { data: dt, receita: 0, cmv: 0, despesas: 0 };
      fluxoDias[dt].despesas += d.valor || 0;
    });
    const fluxoPorDia = Object.values(fluxoDias)
      .sort((a, b) => a.data.localeCompare(b.data))
      .map(d => ({ ...d, custoTotal: d.cmv + d.despesas, resultado: d.receita - d.cmv - d.despesas }));

    return {
      receita:         cmvData.receita,
      cmv:             cmvData.cmv,
      despesas:        totalDespesas,
      totalCustos,
      resultadoLiquido: resultadoLiq,
      margemBruta:     cmvData.margemBruta,
      margemBrutaPct:  cmvData.margemPercentual,
      margemLiquida,
      pctCMV:          cmvData.percentualCMV,
      pctDespesas,
      pctCustoTotal,
      listaCategorias,
      despesasLista:   despesas.sort((a, b) => b.dataCurta.localeCompare(a.dataCurta)),
      fluxoPorDia,
      periodo:         { de, ate },
    };
  }

  // ── Exportar ──────────────────────────────────────────────────────
  window.CH.BIService = {
    carregarHistoricoCompleto,
    getCurvaABC,
    getTicketMedio,
    getCMV,
    getLucroPorCategoria,
    getMargemReal,
    getProdutosParados,
    getHorariosPico,
    getRankingProdutos,
    getFluxoCaixaPeriodo,
    getComparativoPeriodos,
    getDashboardExecutivo,
    getCustosConsolidados,
  };

  console.info('%c BIService ✓  (Curva ABC | CMV | Custos | BI Analytics)', 'color:#10b981;font-weight:bold');
})();
