'use strict';
/**
 * services/financeiroService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Controle financeiro integrado com vendas e estoque.
 *
 * Fluxo automático:
 *   Venda finalizada → registrarReceita (evento venda:finalizada)
 *   Venda cancelada  → registrarEstorno  (evento venda:cancelada)
 *   Entrada estoque  → registrarDespesa  (custo de compra)
 *
 * Modelo de lançamento:
 *   {
 *     id:        string
 *     tipo:      'receita' | 'despesa' | 'estorno'
 *     categoria: string  ('venda', 'compra', 'avaria', 'ajuste', 'outro')
 *     descricao: string
 *     valor:     number  (sempre positivo; tipo define o sinal)
 *     formaPgto: string?
 *     referencia:string? (vendaId, movimentacaoId, etc.)
 *     operador:  string
 *     data:      string  (ISO)
 *     dataCurta: string  (YYYY-MM-DD)
 *     hora:      string
 *   }
 *
 * Requer: core.js carregado antes.
 */

(function () {
  const { Store, AuthService, Utils, EventBus } = window.CH;

  // Cache do histórico COMPLETO de lançamentos, buscado direto da nova
  // coleção 'financeiro_lancamentos' (documento por lançamento, sem corte
  // de quantidade). null até a primeira busca terminar; enquanto isso,
  // getLancamentos() cai no Store.getFinanceiro() antigo (array único,
  // sujeito ao corte de 5.000 já conhecido — mesmo comportamento de antes,
  // sem regressão durante a transição).
  let _lancamentosFullCache = null;

  // Busca o histórico completo uma vez e guarda em cache neste módulo.
  // Deve ser chamada pela tela (financeiro.html) ao carregar.
  async function carregarLancamentosCompletos() {
    if (!window.CH?.FirebaseService?.lerLancamentosFinanceiro) return null; // fallback seguro
    try {
      _lancamentosFullCache = await window.CH.FirebaseService.lerLancamentosFinanceiro({});
      return _lancamentosFullCache;
    } catch (e) {
      console.warn('[FinanceiroService] Falha ao buscar histórico completo, usando cache local (pode estar incompleto):', e.message);
      return null;
    }
  }

  function _todosLancamentos() {
    return _lancamentosFullCache || Store.getFinanceiro() || [];
  }

  // ── Registrar lançamento ──────────────────────────────────────────
  function _lancar({ tipo, categoria, descricao, valor, formaPgto = '', referencia = '', extra = {} }) {
    if (!valor || valor <= 0) return null;

    // FIX #4: Idempotência — impede duplo lançamento para a mesma referência+tipo
    if (referencia) {
      const jaExiste = _todosLancamentos().some(
        l => l.referencia === referencia && l.tipo === tipo
      );
      if (jaExiste) {
        console.info(`[Financeiro] Lançamento ignorado — referencia "${referencia}" tipo "${tipo}" já existe`);
        return null;
      }
    }

    const lancamento = {
      id:         Utils.generateId(),
      tipo,       // 'receita' | 'despesa' | 'estorno'
      categoria,  // 'venda' | 'compra' | 'avaria' | 'outro'
      descricao,
      valor:      Number(valor),
      formaPgto,
      referencia,
      operador:   AuthService.getNome(),
      data:       Utils.nowISO(),
      dataCurta:  Utils.todayISO(),
      hora:       Utils.nowTime(),
      ...extra,
    };

    // Escrita local (mantida por compatibilidade — cache local + telas que
    // ainda leem Store.getFinanceiro() diretamente durante a transição).
    Store.mutateFinanceiro(fin => { fin.unshift(lancamento); });

    // Escrita nova: documento individual em 'financeiro_lancamentos', sem
    // o corte de 5.000 do array único. Não bloqueia _lancar() (que é
    // síncrona e chamada de vários lugares) — roda em paralelo.
    window.CH?.FirebaseService?.salvarLancamentoFinanceiro?.(lancamento)
      .catch(e => console.warn('[FinanceiroService] Falha ao gravar lançamento individual:', e.message));

    // Mantém o cache em memória em dia, se já estiver carregado, para que
    // getLancamentos() reflita o lançamento novo imediatamente.
    if (_lancamentosFullCache) _lancamentosFullCache.unshift(lancamento);

    EventBus.emit('financeiro:lancado', lancamento);
    return lancamento;
  }

  // ── Receitas ──────────────────────────────────────────────────────

  /** Registra receita de uma venda */
  function registrarReceita(venda) {
    // Venda fiado: a dívida foi enviada ao módulo Fiado na validação, mas o
    // dinheiro só entra quando o cliente paga. A receita é reconhecida lá
    // (fiado.html chama registrarReceita novamente, proporcional ao valor
    // pago) — nunca aqui, senão o caixa contaria a venda antes de receber.
    if (venda._fiado) {
      console.info(`[Financeiro] Receita da venda ${venda.id} adiada — fiado só reconhece receita no pagamento`);
      return null;
    }
    return _lancar({
      tipo:       'receita',
      categoria:  'venda',
      descricao:  `Venda #${venda.id.slice(-6)} — ${venda.itens?.length || 0} item(ns)`,
      valor:      venda.total,
      formaPgto:  venda.formaPgto,
      referencia: venda.id,
      extra: {
        lucro:   venda.lucro || 0,
        itens:   venda.itens?.length || 0,
        vendaId: venda.id,
      },
    });
  }

  /** Registra estorno de uma venda cancelada */
  function registrarEstorno(venda) {
    // Espelha o mesmo bloqueio de registrarReceita(): venda fiado nunca
    // gerou uma "receita" correspondente aqui (receita fiado só é
    // reconhecida no pagamento, não na venda) — então lançar um estorno
    // pra ela criaria um estorno fantasma, sem contrapartida, reduzindo o
    // faturamento reportado indevidamente. A reversão do saldo do cliente,
    // quando aplicável, é feita separadamente (ver AprovacaoService).
    if (venda._fiado) {
      console.info(`[Financeiro] Estorno da venda ${venda.id} ignorado — venda fiado nunca gerou receita aqui`);
      return null;
    }
    return _lancar({
      tipo:       'estorno',
      categoria:  'cancelamento',
      descricao:  `Estorno venda #${venda.id.slice(-6)}`,
      valor:      venda.total,
      formaPgto:  venda.formaPgto,
      referencia: venda.id,
    });
  }

  // ── Despesas ──────────────────────────────────────────────────────

  /** Registra despesa manualmente */
  function registrarDespesa({ descricao, valor, categoria = 'outro', formaPgto = '', referencia = '' }) {
    return _lancar({ tipo: 'despesa', categoria, descricao, valor, formaPgto, referencia });
  }

  /** Registra custo de entrada de estoque */
  function registrarCustoCompra(mov) {
    const custo = Math.abs(mov.custo || 0) * Math.abs(mov.quantidade || 0);
    if (!custo) return null;
    return _lancar({
      tipo:       'despesa',
      categoria:  'compra',
      descricao:  `Compra: ${mov.nomeProduto} (${Math.abs(mov.quantidade)} un.)`,
      valor:      custo,
      referencia: mov.id,
    });
  }

  // ── Consultas ─────────────────────────────────────────────────────

  // BUG CORRIGIDO: o parâmetro `limit` (default 500) cortava o resultado
  // ANTES de somar — relatórios de período "Geral" pareciam travados num
  // valor porque nunca refletiam o histórico real, só uma fatia rotativa
  // dele. Agora usa o histórico completo (_todosLancamentos) sem corte;
  // `limit` continua aceito por compatibilidade, mas só é aplicado se
  // explicitamente passado por quem chama.
  function getLancamentos({ tipo, categoria, dataDe, dataAte, limit } = {}) {
    let fin = _todosLancamentos();
    if (tipo)      fin = fin.filter(l => l.tipo      === tipo);
    if (categoria) fin = fin.filter(l => l.categoria === categoria);
    if (dataDe)    fin = fin.filter(l => l.dataCurta >= dataDe);
    if (dataAte)   fin = fin.filter(l => l.dataCurta <= dataAte);
    return limit ? fin.slice(0, limit) : fin;
  }

  function getCaixaDia(data = Utils.todayISO()) {
    const lancamentos = getLancamentos({ dataDe: data, dataAte: data });

    const receitas = lancamentos.filter(l => l.tipo === 'receita').reduce((s, l) => s + l.valor, 0);
    const despesas = lancamentos.filter(l => l.tipo === 'despesa').reduce((s, l) => s + l.valor, 0);
    const estornos = lancamentos.filter(l => l.tipo === 'estorno').reduce((s, l) => s + l.valor, 0);
    const lucro    = lancamentos.filter(l => l.tipo === 'receita').reduce((s, l) => s + (l.lucro || 0), 0);

    // Agrupamento por forma de pagamento (receitas)
    const porForma = {};
    lancamentos.filter(l => l.tipo === 'receita').forEach(l => {
      const f = l.formaPgto || 'Outros';
      porForma[f] = (porForma[f] || 0) + l.valor;
    });

    return {
      data,
      receitas,
      despesas,
      estornos,
      saldo:  receitas - despesas - estornos,
      lucro,
      lancamentos,
      porForma,
    };
  }

  function getFluxoCaixa(dataDe, dataAte) {
    // Agrupa por dia
    const dias = {};
    getLancamentos({ dataDe, dataAte }).forEach(l => {
      if (!dias[l.dataCurta]) {
        dias[l.dataCurta] = { data: l.dataCurta, receitas: 0, despesas: 0, estornos: 0, lucro: 0 };
      }
      if (l.tipo === 'receita') { dias[l.dataCurta].receitas += l.valor; dias[l.dataCurta].lucro += (l.lucro || 0); }
      if (l.tipo === 'despesa') dias[l.dataCurta].despesas += l.valor;
      if (l.tipo === 'estorno') dias[l.dataCurta].estornos += l.valor;
    });

    return Object.values(dias)
      .sort((a, b) => a.data.localeCompare(b.data))
      .map(d => ({ ...d, saldo: d.receitas - d.despesas - d.estornos }));
  }

  function getResumoMes(ano = new Date().getFullYear(), mes = new Date().getMonth() + 1) {
    const dataDe = `${ano}-${String(mes).padStart(2,'0')}-01`;
    const dataAte = `${ano}-${String(mes).padStart(2,'0')}-31`;
    const caixa  = getCaixaDia(dataDe); // usa range
    const lancamentos = getLancamentos({ dataDe, dataAte });
    const receitas = lancamentos.filter(l => l.tipo === 'receita').reduce((s, l) => s + l.valor, 0);
    const despesas = lancamentos.filter(l => l.tipo === 'despesa').reduce((s, l) => s + l.valor, 0);
    const lucro    = lancamentos.filter(l => l.tipo === 'receita').reduce((s, l) => s + (l.lucro || 0), 0);
    return { mes: `${ano}-${String(mes).padStart(2,'0')}`, receitas, despesas, saldo: receitas - despesas, lucro };
  }

  // Exportar CSV
  function exportarCSV(dataDe, dataAte) {
    const lancamentos = getLancamentos({ dataDe, dataAte });
    const header = ['data','hora','tipo','categoria','descricao','valor','formaPgto','operador'];
    const rows = lancamentos.map(l =>
      header.map(k => `"${String(l[k] !== undefined ? l[k] : '').replace(/"/g,'""')}"`).join(',')
    );
    const csv = [header.join(','), ...rows].join('\n');
    Utils.downloadBlob('\uFEFF' + csv, 'text/csv;charset=utf-8', `financeiro_${Utils.todayISO()}.csv`);
  }

  // ── Hooks automáticos ─────────────────────────────────────────────
  EventBus.on('venda:finalizada',     venda => registrarReceita(venda));
  EventBus.on('venda:cancelada',      ({ vendaId }) => {
    const venda = window.CH.Store.getVendas().find(v => v.id === vendaId);
    if (venda) registrarEstorno(venda);
  });
  EventBus.on('estoque:movimentado',  mov => {
    if (mov.tipo === 'entrada') registrarCustoCompra(mov);
  });

  // ── Exportar ─────────────────────────────────────────────────────
  window.CH.FinanceiroService = {
    carregarLancamentosCompletos,
    registrarReceita,
    registrarEstorno,
    registrarDespesa,
    registrarCustoCompra,
    getLancamentos,
    getCaixaDia,
    getFluxoCaixa,
    getResumoMes,
    exportarCSV,
  };

  console.info('%c FinanceiroService ✓  (Integrado com vendas + estoque)', 'color:#10b981');
})();
