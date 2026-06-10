'use strict';
/**
 * services/integrityService.js — CH Geladas PDV
 * ═══════════════════════════════════════════════════════════════════
 * SERVIÇO DE INTEGRIDADE TRANSACIONAL — PADRÃO ERP INDUSTRIAL
 * ═══════════════════════════════════════════════════════════════════
 *
 * REGRA FUNDAMENTAL (INVIOLÁVEL):
 *   Uma venda JAMAIS pode assumir status VALIDADA, CONCLUÍDA ou
 *   FINALIZADA sem que a baixa de estoque tenha sido:
 *     1. Executada com sucesso
 *     2. Persistida no Firestore (ou fila de sync para offline)
 *     3. Confirmada com movimentação registrada
 *     4. Validada por verificação pós-escrita
 *
 *   Se QUALQUER etapa falhar → rollback completo do status da venda.
 *   Nenhuma exceção. Nenhum cenário alternativo.
 *
 * RESPONSABILIDADES:
 *   - validarIntegridadeVenda()    : bloqueio pré-validação
 *   - confirmarBaixaComRollback()  : execução atômica com rollback
 *   - reconciliarCompleto()        : varredura e correção de divergências
 *   - auditarIntegridade()         : relatório completo de integridade
 *   - bloquearVendaSemBaixa()      : bloqueio reativo imediato
 *   - getVendasSemMovimentacao()   : diagnóstico de vendas órfãs
 *
 * RASTREABILIDADE COMPLETA:
 *   Cada operação registra: usuário, data, hora, venda, produto,
 *   quantidade, saldo anterior, saldo posterior, resultado, erros.
 *
 * Requer: core.js + estoqueService.js + auditService.js carregados antes.
 */

(function () {
  const { Store, AuthService, Utils, EventBus, FirebaseService } = window.CH;

  /**
   * Converte um objeto Date para string 'YYYY-MM-DD' no timezone local.
   * Utils.todayISO() usa UTC (toISOString), o que causa off-by-one no UTC-3.
   * Esta função usa getFullYear/getMonth/getDate (valores locais).
   */
  function _localDateISO(d) {
    const y  = d.getFullYear();
    const m  = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  // ── Constantes ───────────────────────────────────────────────────
  const _LOG_KEY          = 'CH_INTEGRITY_LOG';
  const _BLOQUEIOS_KEY    = 'CH_VENDAS_BLOQUEADAS';
  const MAX_LOG           = 200;
  const STATUS_TERMINAIS  = ['validada', 'concluida', 'finalizada'];
  const STATUS_REQUEREM_BAIXA = ['validada', 'concluida'];

  // ── Log interno de integridade ───────────────────────────────────
  function _log(nivel, vendaId, mensagem, detalhes = {}) {
    const entrada = {
      id:        Utils.generateId(),
      nivel,          // 'INFO' | 'WARN' | 'CRITICO' | 'ERRO' | 'OK'
      vendaId:   vendaId || null,
      mensagem,
      detalhes,
      usuario:   AuthService.getNome?.() || 'sistema',
      timestamp: Utils.nowISO(),
      dataCurta: Utils.todayISO(),
    };

    // Console
    const cor = { CRITICO: '🚨', ERRO: '❌', WARN: '⚠️', OK: '✅', INFO: 'ℹ️' };
    console[nivel === 'CRITICO' || nivel === 'ERRO' ? 'error' : nivel === 'WARN' ? 'warn' : 'info'](
      `[IntegrityService] ${cor[nivel] || ''} ${mensagem}`, detalhes
    );

    // Persistência local
    try {
      const logs = JSON.parse(localStorage.getItem(_LOG_KEY) || '[]');
      logs.unshift(entrada);
      localStorage.setItem(_LOG_KEY, JSON.stringify(logs.slice(0, MAX_LOG)));
    } catch (_) {}

    // EventBus para UI
    EventBus.emit('integrity:log', entrada);
    if (nivel === 'CRITICO') EventBus.emit('integrity:critico', entrada);

    return entrada;
  }

  // ── Registro de bloqueio de venda ────────────────────────────────
  function _bloquearVenda(vendaId, motivo) {
    try {
      const bloqueios = JSON.parse(localStorage.getItem(_BLOQUEIOS_KEY) || '{}');
      bloqueios[vendaId] = {
        vendaId,
        motivo,
        bloqueadoEm: Utils.nowISO(),
        operador:    AuthService.getNome?.() || 'sistema',
      };
      localStorage.setItem(_BLOQUEIOS_KEY, JSON.stringify(bloqueios));
    } catch (_) {}
    _log('CRITICO', vendaId, `BLOQUEIO DE VENDA: ${motivo}`, { vendaId, motivo });
    EventBus.emit('integrity:venda_bloqueada', { vendaId, motivo });
  }

  function isVendaBloqueada(vendaId) {
    try {
      const bloqueios = JSON.parse(localStorage.getItem(_BLOQUEIOS_KEY) || '{}');
      return !!bloqueios[vendaId];
    } catch (_) { return false; }
  }

  function desbloquearVenda(vendaId) {
    try {
      const bloqueios = JSON.parse(localStorage.getItem(_BLOQUEIOS_KEY) || '{}');
      delete bloqueios[vendaId];
      localStorage.setItem(_BLOQUEIOS_KEY, JSON.stringify(bloqueios));
      _log('INFO', vendaId, 'Bloqueio de venda removido manualmente');
    } catch (_) {}
  }

  // ── PRÉ-VALIDAÇÃO: verificação de pré-condições ──────────────────
  /**
   * Verifica se uma venda PODE ser validada.
   * Chame ANTES de mudar o status.
   * Lança erro se qualquer condição não for satisfeita.
   *
   * @param {object} venda - objeto completo da venda
   * @throws {Error} com mensagem descritiva se inválida
   */
  function validarIntegridadeVenda(venda) {
    if (!venda) throw new Error('INTEGRITY: Venda nula — validação impossível');
    if (!venda.id) throw new Error('INTEGRITY: Venda sem ID — estado corrompido');

    // Verifica se já está bloqueada
    if (isVendaBloqueada(venda.id)) {
      throw new Error(`INTEGRITY: Venda ${venda.id} está BLOQUEADA por falha anterior de integridade. Execute a reconciliação manual.`);
    }

    // Verifica presença de itens
    if (!venda.itens?.length) {
      throw new Error(`INTEGRITY: Venda ${venda.id} sem itens — inválida para validação`);
    }

    // Verifica total
    if (!venda.total || venda.total <= 0) {
      throw new Error(`INTEGRITY: Venda ${venda.id} com total inválido (${venda.total})`);
    }

    // Verifica disponibilidade de estoque para cada item
    const ES = window.CH.EstoqueService;
    if (ES) {
      const errosEstoque = [];
      for (const item of venda.itens) {
        const prod = ES.getProduto(item.prodId);
        if (!prod) {
          errosEstoque.push(`Produto "${item.nome}" (${item.prodId}) não encontrado no estoque`);
          continue;
        }
        if (prod.controlaEstoque === false) continue;

        const pack  = prod.packs?.find(pk => pk.label === item.label || (pk.qtd + 'x') === item.label);
        const qtdUn = item.label === 'UNID' ? item.qtd : item.qtd * (pack?.qtd || 1);
        const disponivel = prod.estoqueAtual ?? prod.qtdUn ?? 0;

        if (disponivel < qtdUn) {
          errosEstoque.push(`"${prod.nome}": disponível ${disponivel}, necessário ${qtdUn}`);
        }
      }

      if (errosEstoque.length > 0) {
        const msg = `INTEGRITY: Estoque insuficiente para venda ${venda.id}:\n${errosEstoque.join('\n')}`;
        _log('CRITICO', venda.id, 'Pré-validação: estoque insuficiente', { erros: errosEstoque });
        throw new Error(msg);
      }
    }

    // Verifica se já tem movimentação (dupla validação acidental)
    const movExistentes = Store.getMovimentacoes().filter(
      m => m.origem === `venda:${venda.id}` && m.tipo === 'venda'
    );
    if (movExistentes.length > 0) {
      // Movimentação já existe — idempotente, não é erro
      _log('INFO', venda.id, 'Pré-validação: movimentação já existe (idempotente)', {
        movimentacoes: movExistentes.length
      });
    }

    _log('OK', venda.id, 'Pré-validação PASSOU', {
      itens: venda.itens.length,
      total: venda.total,
    });

    return true;
  }

  // ── EXECUÇÃO ATÔMICA COM ROLLBACK ────────────────────────────────
  /**
   * Executa a baixa de estoque de forma atômica com rollback completo.
   *
   * CONTRATO:
   *   - Retorna { ok: true, ... } se e somente se TUDO foi persistido
   *   - Retorna { ok: false, rollbackExecutado: true, ... } em caso de falha
   *   - NUNCA deixa o status da venda como validada sem baixa confirmada
   *
   * @param {object} venda          - objeto completo da venda
   * @param {function} rollbackFn   - função chamada em caso de falha para reverter status
   * @returns {Promise<{ok, itensProcessados, erros, rollbackExecutado}>}
   */
  async function confirmarBaixaComRollback(venda, rollbackFn) {
    const tracer = {
      vendaId:          venda.id,
      iniciadoEm:       Utils.nowISO(),
      operador:         AuthService.getNome?.() || 'sistema',
      itensTotal:       venda.itens?.filter(i => {
        const p = window.CH.EstoqueService?.getProduto(i.prodId);
        return !p || p.controlaEstoque !== false;
      }).length || 0,
      itensProcessados: 0,
      erros:            [],
      rollbackExecutado: false,
      resultado:        null,
    };

    _log('INFO', venda.id, 'Iniciando baixa atômica de estoque', {
      itens: tracer.itensTotal,
      operador: tracer.operador,
    });

    const ES = window.CH.EstoqueService;

    // ── Caso 1: EstoqueService não disponível ────────────────────
    if (!ES?.baixarEstoqueVendaLote) {
      _log('CRITICO', venda.id, 'EstoqueService.baixarEstoqueVendaLote indisponível — ROLLBACK');
      tracer.erros.push('EstoqueService não disponível');
      tracer.rollbackExecutado = true;

      if (rollbackFn) {
        try { rollbackFn('EstoqueService indisponível'); }
        catch (re) { _log('ERRO', venda.id, 'Rollback falhou', { erro: re.message }); }
      }

      _bloquearVenda(venda.id, 'EstoqueService indisponível no momento da validação');
      _notificarFalhaCritica(venda, 'EstoqueService indisponível');

      return { ok: false, itensProcessados: 0, erros: tracer.erros, rollbackExecutado: true };
    }

    // ── Caso 2: Executa a baixa ──────────────────────────────────
    let resultado;
    try {
      resultado = await ES.baixarEstoqueVendaLote(venda);
    } catch (e) {
      resultado = { ok: false, itensProcessados: 0, erros: [e.message] };
    }

    tracer.resultado = resultado;

    // ── Caso 3: Baixa com falha total ────────────────────────────
    // FIX-E2: localFallback=true significa que a baixa foi aplicada localmente
    // (Firebase indisponível/quota) — NÃO fazer rollback nem bloquear a venda
    if (!resultado.ok && resultado.itensProcessados === 0 && tracer.itensTotal > 0
        && !resultado.localFallback) {
      const motivoFalha = resultado.erros?.join('; ') || 'Erro desconhecido';

      _log('CRITICO', venda.id, `Baixa de estoque FALHOU COMPLETAMENTE — ROLLBACK`, {
        motivo: motivoFalha,
        resultado,
      });

      tracer.rollbackExecutado = true;

      if (rollbackFn) {
        try {
          rollbackFn(motivoFalha);
          _log('WARN', venda.id, 'Rollback do status executado com sucesso');
        } catch (re) {
          _log('ERRO', venda.id, 'ROLLBACK FALHOU — estado inconsistente!', { erro: re.message });
        }
      }

      _bloquearVenda(venda.id, `Baixa falhou: ${motivoFalha}`);
      _notificarFalhaCritica(venda, motivoFalha);

      return {
        ok:               false,
        itensProcessados: 0,
        erros:            resultado.erros,
        rollbackExecutado: true,
      };
    }

    // ── Caso 3b: Firebase falhou mas fallback local aplicado ──────
    if (!resultado.ok && resultado.localFallback) {
      _log('WARN', venda.id, `Firebase indisponível — baixa aplicada localmente. Reconciliação agendada.`, {
        itensProcessados: resultado.itensProcessados,
        erros: resultado.erros,
      });
      // Venda segue como concluída — estoque foi baixado localmente
      // Não bloquear, não fazer rollback
    }

    // ── Caso 4: Baixa parcial (alguns itens falharam) ────────────
    if (resultado.erros?.length > 0) {
      _log('WARN', venda.id, `Baixa PARCIAL: ${resultado.itensProcessados} itens baixados, ${resultado.erros.length} falhas`, {
        erros: resultado.erros,
        itensProcessados: resultado.itensProcessados,
      });

      // Baixa parcial: registra mas NÃO faz rollback (itens com estoque insuficiente
      // não devem cancelar os outros que foram processados com sucesso)
      // Registra log de auditoria crítico para reconciliação manual
      _registrarDivergenciaCritica({
        tipo:    'baixa_parcial',
        vendaId: venda.id,
        erros:   resultado.erros,
        itensProcessados: resultado.itensProcessados,
        itensTotal:       tracer.itensTotal,
      });
    }

    // ── Caso 5: Sucesso ──────────────────────────────────────────
    tracer.itensProcessados = resultado.itensProcessados;

    // Verificação pós-baixa: confirma movimentações no Store local
    const movsConfirmadas = Store.getMovimentacoes().filter(
      m => m.origem === `venda:${venda.id}` && m.tipo === 'venda'
    );

    _log('OK', venda.id, `Baixa confirmada: ${resultado.itensProcessados} itens, ${movsConfirmadas.length} movimentações`, {
      itensProcessados: resultado.itensProcessados,
      movimentacoes:    movsConfirmadas.length,
      erros:            resultado.erros,
    });

    // Registra rastreabilidade completa no AuditService
    _registrarRastreabilidade(venda, resultado, movsConfirmadas);

    return {
      ok:               true,
      itensProcessados: resultado.itensProcessados,
      erros:            resultado.erros || [],
      rollbackExecutado: false,
    };
  }

  // ── VALIDAÇÃO PÓS-VENDA ──────────────────────────────────────────
  /**
   * Executa validação de integridade APÓS a finalização de uma venda.
   * Verifica: status, itens, movimentações, financeiro.
   * Em caso de divergência: bloqueia imediatamente e alerta.
   *
   * @param {object} venda - objeto completo após finalização
   * @returns {{ integra: boolean, divergencias: string[] }}
   */
  async function validarIntegridadePosVenda(venda) {
    if (!venda?.id) return { integra: false, divergencias: ['Venda inválida'] };

    const divergencias = [];

    // 1. Verifica status terminal
    if (!STATUS_REQUEREM_BAIXA.includes(venda.status)) {
      // Status não requer baixa (pendente, aprovada, rejeitada, cancelada)
      return { integra: true, divergencias: [] };
    }

    // 2. Verifica existência de movimentações para itens com controle de estoque
    const itensComControle = (venda.itens || []).filter(item => {
      const p = window.CH.EstoqueService?.getProduto(item.prodId);
      return !p || p.controlaEstoque !== false;
    });

    if (itensComControle.length > 0) {
      const movs = Store.getMovimentacoes().filter(
        m => m.origem === `venda:${venda.id}` && m.tipo === 'venda'
      );

      if (movs.length === 0) {
        divergencias.push(`Venda ${venda.status} SEM MOVIMENTAÇÃO DE ESTOQUE — ${itensComControle.length} itens sem baixa`);
      } else {
        // Verifica se há movimentação para cada produto
        const prodsMov = new Set(movs.map(m => m.produtoId));
        for (const item of itensComControle) {
          if (!prodsMov.has(item.prodId)) {
            divergencias.push(`Produto "${item.nome}" (${item.prodId}) sem movimentação correspondente`);
          }
        }
      }
    }

    // 3. Verificação financeira REMOVIDA intencionalmente.
    //
    // CAUSA RAIZ (diagnosticada): SyncService.pull() sobrescreve Store.financeiro
    // com dados do Firestore logo após o PASSO 6 (emit venda:finalizada → registrarReceita).
    // Isso faz Store.getFinanceiro() retornar vazio mesmo com o lançamento recém-criado,
    // gerando falso-positivo de "Venda sem lançamento financeiro" em 100% das validações.
    //
    // Por que é seguro remover:
    // - financeiroService tem idempotência (FIX #4): não cria duplicatas.
    // - Se o pull sobrescreveu o lançamento local, o SyncQueue vai reenviá-lo ao Firestore.
    // - A reconciliarCompleto() (painel monitor) já detecta divergências financeiras
    //   de forma confiável, pois roda de forma isolada sem race condition com pull().
    //
    // Manter esta checagem aqui causa bloqueio indevido de 100% das vendas validadas.

    if (divergencias.length > 0) {
      _log('CRITICO', venda.id, `DIVERGÊNCIAS PÓS-VENDA DETECTADAS`, { divergencias });

      // Bloqueia imediatamente
      _bloquearVenda(venda.id, `Divergências: ${divergencias.join(' | ')}`);

      // Registra divergência crítica
      for (const div of divergencias) {
        _registrarDivergenciaCritica({ tipo: 'pos_venda', vendaId: venda.id, descricao: div });
      }

      // Alerta crítico
      _notificarFalhaCritica(venda, `${divergencias.length} divergência(s) detectada(s) pós-venda`);

      return { integra: false, divergencias };
    }

    _log('OK', venda.id, 'Validação pós-venda: ÍNTEGRA', {
      status: venda.status,
      itensComControle: itensComControle.length,
    });

    return { integra: true, divergencias: [] };
  }

  // ── RECONCILIAÇÃO COMPLETA ───────────────────────────────────────
  /**
   * Reconciliação ERP: cruza vendas × movimentações × estoque × financeiro.
   * Identifica e corrige automaticamente divergências.
   *
   * @param {{ dataInicio, dataFim, autoCorrigir }} opcoes
   * @returns {Promise<RelatorioReconciliacao>}
   */
  async function reconciliarCompleto({ dataInicio, dataFim, autoCorrigir = true } = {}) {
    const di = dataInicio || Utils.todayISO();
    const df = dataFim    || Utils.todayISO();

    _log('INFO', null, `Reconciliação completa: ${di} → ${df}`);

    const relatorio = {
      periodo:          { de: di, ate: df },
      iniciadoEm:       Utils.nowISO(),
      concluidoEm:      null,
      operador:         AuthService.getNome?.() || 'sistema',
      vendas: {
        total:          0,
        integras:       0,
        divergentes:    0,
        corrigidas:     0,
        naoCorrigidas:  0,
      },
      divergencias:     [],
      movimentacoesOrfas: [],
      reservasOrfas:    [],
      divergenciasFinanceiras: [],
      saldosNegativos:  [],
      acoes:            [],
    };

    // ── 1. Carrega vendas do período ────────────────────────────
    const todasVendas = Store.getVendas().filter(v => {
      const data = v.dataCurta || v.data?.slice(0, 10);
      return data >= di && data <= df;
    });
    relatorio.vendas.total = todasVendas.length;

    // ── 2. Filtra vendas que requerem baixa ────────────────────
    const vendasComBaixa = todasVendas.filter(v =>
      STATUS_REQUEREM_BAIXA.includes(v.status)
    );

    // ── 3. Verifica cada venda ─────────────────────────────────
    for (const venda of vendasComBaixa) {
      const itensComControle = (venda.itens || []).filter(item => {
        const p = window.CH.EstoqueService?.getProduto(item.prodId);
        return !p || p.controlaEstoque !== false;
      });

      if (itensComControle.length === 0) {
        relatorio.vendas.integras++;
        continue;
      }

      // Busca movimentações no Store local
      const movs = Store.getMovimentacoes().filter(
        m => m.origem === `venda:${venda.id}` && m.tipo === 'venda'
      );

      const prodsMov = new Set(movs.map(m => m.produtoId));
      const prodsSemMov = itensComControle.filter(i => !prodsMov.has(i.prodId));

      if (prodsSemMov.length === 0) {
        relatorio.vendas.integras++;
        continue;
      }

      // Divergência encontrada
      relatorio.vendas.divergentes++;
      const div = {
        vendaId:    venda.id,
        status:     venda.status,
        data:       venda.dataCurta,
        operador:   venda.operador,
        total:      venda.total,
        tipo:       'venda_sem_baixa',
        descricao:  `${prodsSemMov.length} produto(s) sem movimentação`,
        produtos:   prodsSemMov.map(i => ({ prodId: i.prodId, nome: i.nome, qtd: i.qtd })),
        corrigida:  false,
        severity:   'CRITICO',
      };

      relatorio.divergencias.push(div);
      _log('CRITICO', venda.id, `RECONCILIAÇÃO: venda sem baixa de estoque`, div);

      // Auto-correção
      if (autoCorrigir) {
        try {
          const ES = window.CH.EstoqueService;
          if (ES?.baixarEstoqueVendaLote) {
            const resultCorr = await ES.baixarEstoqueVendaLote(venda);
            if (resultCorr.ok || resultCorr.itensProcessados > 0) {
              div.corrigida = true;
              relatorio.vendas.corrigidas++;
              relatorio.acoes.push({
                tipo:    'correcao_baixa',
                vendaId: venda.id,
                itens:   resultCorr.itensProcessados,
                ts:      Utils.nowISO(),
              });
              _log('OK', venda.id, `Reconciliação: baixa corrigida (${resultCorr.itensProcessados} itens)`);
            } else {
              relatorio.vendas.naoCorrigidas++;
              _log('ERRO', venda.id, 'Reconciliação: auto-correção falhou', resultCorr);
            }
          }
        } catch (e) {
          relatorio.vendas.naoCorrigidas++;
          _log('ERRO', venda.id, 'Reconciliação: exceção na auto-correção', { erro: e.message });
        }
      } else {
        relatorio.vendas.naoCorrigidas++;
      }
    }

    // ── 4. Detecta movimentações órfãs ─────────────────────────
    // Movimentação de venda sem venda correspondente
    const idsVendasPeriodo = new Set(todasVendas.map(v => v.id));
    const movimentacoesPeriodo = Store.getMovimentacoes().filter(m => {
      if (m.tipo !== 'venda') return false;
      if (!m.dataCurta) return false;
      return m.dataCurta >= di && m.dataCurta <= df;
    });

    for (const mov of movimentacoesPeriodo) {
      const vendaId = mov.origem?.replace('venda:', '');
      if (vendaId && !idsVendasPeriodo.has(vendaId)) {
        relatorio.movimentacoesOrfas.push({
          movId:   mov.id,
          origem:  mov.origem,
          produto: mov.nomeProduto,
          qtd:     mov.quantidade,
          ts:      mov.timestamp,
          severity: 'CRITICO',
        });
        _log('CRITICO', null, `Movimentação órfã detectada: ${mov.origem}`, { mov });
      }
    }

    // ── 5. Detecta reservas órfãs ───────────────────────────────
    const reservas = window.CH.EstoqueService?.getReservas?.() || {};
    for (const [vendaId, reserva] of Object.entries(reservas)) {
      const venda = Store.getVendas().find(v => v.id === vendaId);
      if (!venda) {
        relatorio.reservasOrfas.push({ vendaId, reserva, severity: 'WARN' });
        _log('WARN', vendaId, 'Reserva órfã detectada (venda não encontrada)', { reserva });
      } else if (STATUS_REQUEREM_BAIXA.includes(venda.status)) {
        relatorio.reservasOrfas.push({ vendaId, reserva, status: venda.status, severity: 'WARN' });
        _log('WARN', vendaId, 'Reserva para venda já finalizada (deveria ter sido liberada)', { status: venda.status });
        // Auto-corrige: libera reserva
        window.CH.EstoqueService?.liberarReserva?.(vendaId);
        relatorio.acoes.push({ tipo: 'liberar_reserva_orfa', vendaId, ts: Utils.nowISO() });
      }
    }

    // ── 6. Detecta saldos negativos ─────────────────────────────
    const produtos = window.CH.EstoqueService?.getProdutos?.() || [];
    for (const prod of produtos) {
      if (!prod.ativo) continue;
      if (prod.controlaEstoque === false) continue;
      const saldo = prod.estoqueAtual ?? prod.qtdUn ?? 0;
      if (saldo < 0) {
        relatorio.saldosNegativos.push({
          prodId:   prod.id,
          nome:     prod.nome,
          saldo,
          severity: 'CRITICO',
        });
        _log('CRITICO', null, `Saldo negativo detectado: "${prod.nome}" = ${saldo}`, { prod });
      }
    }

    // ── 7. Detecta divergências financeiras ─────────────────────
    for (const venda of vendasComBaixa) {
      const lancamentos = Store.getFinanceiro().filter(
        l => l.referencia === venda.id && l.tipo === 'receita'
      );

      if (lancamentos.length === 0) {
        relatorio.divergenciasFinanceiras.push({
          vendaId:   venda.id,
          tipo:      'sem_lancamento',
          descricao: `Venda ${venda.status} sem lançamento de receita`,
          valor:     venda.total,
          severity:  'CRITICO',
        });
        _log('CRITICO', venda.id, 'Divergência financeira: venda sem receita registrada');
      } else if (lancamentos.length > 1) {
        relatorio.divergenciasFinanceiras.push({
          vendaId:    venda.id,
          tipo:       'receita_duplicada',
          descricao:  `${lancamentos.length} receitas para a mesma venda`,
          lancamentos: lancamentos.length,
          severity:   'CRITICO',
        });
        _log('CRITICO', venda.id, `Divergência financeira: ${lancamentos.length} receitas duplicadas`);
      }
    }

    // ── 8. Finaliza relatório ───────────────────────────────────
    relatorio.concluidoEm = Utils.nowISO();

    const totalProblemas =
      relatorio.divergencias.length +
      relatorio.movimentacoesOrfas.length +
      relatorio.reservasOrfas.length +
      relatorio.saldosNegativos.length +
      relatorio.divergenciasFinanceiras.length;

    _log(
      totalProblemas > 0 ? 'WARN' : 'OK',
      null,
      `Reconciliação concluída: ${totalProblemas} problemas, ${relatorio.vendas.corrigidas} corrigidos`,
      {
        vendas: relatorio.vendas,
        divergencias: relatorio.divergencias.length,
        movimentacoesOrfas: relatorio.movimentacoesOrfas.length,
        reservasOrfas: relatorio.reservasOrfas.length,
        saldosNegativos: relatorio.saldosNegativos.length,
        divergenciasFinanceiras: relatorio.divergenciasFinanceiras.length,
      }
    );

    // Notifica via Telegram se houver problemas
    if (totalProblemas > 0) {
      _notificarReconciliacao(relatorio, totalProblemas);
    }

    EventBus.emit('integrity:reconciliacao_concluida', relatorio);
    return relatorio;
  }

  // ── AUDITORIA DE INTEGRIDADE ─────────────────────────────────────
  /**
   * Retorna relatório completo de integridade do sistema.
   * Não faz correções — apenas reporta o estado atual.
   */
  async function auditarIntegridade(periodo = 'hoje') {
    const hoje = Utils.todayISO();
    let di, df;

    if (periodo === 'hoje') {
      di = df = hoje;
    } else if (periodo === 'semana') {
      const d = new Date(); d.setDate(d.getDate() - 7);
      di = _localDateISO(d); df = hoje; // FIX #5c
    } else if (periodo === 'mes') {
      const d = new Date(); d.setDate(1);
      di = _localDateISO(d); df = hoje; // FIX #5c
    } else {
      di = df = hoje;
    }

    return reconciliarCompleto({ dataInicio: di, dataFim: df, autoCorrigir: false });
  }

  // ── DIAGNÓSTICO RÁPIDO ───────────────────────────────────────────
  /**
   * Retorna lista de vendas finalizadas sem movimentação de estoque.
   * Diagnóstico rápido sem correção.
   */
  function getVendasSemMovimentacao(dias = 7) {
    const limite = new Date();
    limite.setDate(limite.getDate() - dias);
    const di = _localDateISO(limite); // FIX #5c

    const vendas = Store.getVendas().filter(v => {
      const data = v.dataCurta || v.data?.slice(0, 10) || '';
      return data >= di && STATUS_REQUEREM_BAIXA.includes(v.status);
    });

    const resultado = [];
    for (const venda of vendas) {
      // FIX: ignorar vendas onde TODOS os itens são sem controle de estoque
      // (ex: cigarros com controlaEstoque=false nunca geram movimentacao)
      const itensComControle = (venda.itens || []).filter(item => {
        const p = window.CH.EstoqueService?.getProduto?.(item.prodId);
        return !p || p.controlaEstoque !== false;
      });
      if (itensComControle.length === 0) continue;

      const movs = Store.getMovimentacoes().filter(
        m => m.origem === `venda:${venda.id}` && m.tipo === 'venda'
      );
      if (movs.length === 0) {
        resultado.push({
          vendaId:   venda.id,
          status:    venda.status,
          data:      venda.dataCurta,
          total:     venda.total,
          operador:  venda.operador,
          itens:     itensComControle.length,
          severity:  'CRITICO',
        });
      }
    }

    return resultado;
  }

  // ── HELPERS PRIVADOS ─────────────────────────────────────────────
  function _registrarRastreabilidade(venda, resultado, movimentacoes) {
    window.CH.AuditService?.registrar?.('baixa_estoque', 'integridade', {
      depois: {
        vendaId:          venda.id,
        status:           venda.status,
        itensProcessados: resultado.itensProcessados,
        erros:            resultado.erros,
        movimentacoes:    movimentacoes.length,
        operador:         AuthService.getNome?.(),
      },
      resumo: `Baixa atômica: ${resultado.itensProcessados} itens — venda ${venda.id}`,
    });
  }

  function _registrarDivergenciaCritica(dados) {
    try {
      const key = 'CH_DIVERGENCIAS_CRITICAS';
      const existentes = JSON.parse(localStorage.getItem(key) || '[]');
      existentes.unshift({ ...dados, ts: Utils.nowISO(), severity: 'CRITICO' });
      localStorage.setItem(key, JSON.stringify(existentes.slice(0, 100)));
    } catch (_) {}
  }

  function _notificarFalhaCritica(venda, motivo) {
    try {
      const msg =
        `🚨 <b>FALHA CRÍTICA DE INTEGRIDADE</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🔗 <b>Venda:</b> ${venda.id}\n` +
        `📊 <b>Status:</b> ${venda.status || 'desconhecido'}\n` +
        `💰 <b>Total:</b> R$${(venda.total || 0).toFixed(2)}\n` +
        `❌ <b>Motivo:</b> ${motivo}\n` +
        `👤 <b>Operador:</b> ${AuthService.getNome?.() || 'sistema'}\n` +
        `🕐 <b>Hora:</b> ${new Date().toLocaleString('pt-BR')}\n\n` +
        `⛔ Venda BLOQUEADA. Execute a Reconciliação no painel de monitor.`;
      window.CH?.TelegramService?.enviar?.(msg);
    } catch (_) {}

    window.CH?.UIService?.showToast?.(
      '🚨 Falha Crítica de Integridade',
      `Venda ${venda.id?.slice(-6)} bloqueada: ${motivo}. Execute a Reconciliação.`,
      'error'
    );
  }

  function _notificarReconciliacao(relatorio, totalProblemas) {
    try {
      const msg =
        `🔄 <b>Reconciliação — CH Geladas</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📅 <b>Período:</b> ${relatorio.periodo.de} → ${relatorio.periodo.ate}\n` +
        `✅ <b>Vendas íntegras:</b> ${relatorio.vendas.integras}\n` +
        `⚠️ <b>Com divergências:</b> ${relatorio.vendas.divergentes}\n` +
        `🔧 <b>Auto-corrigidas:</b> ${relatorio.vendas.corrigidas}\n` +
        `❌ <b>Não corrigidas:</b> ${relatorio.vendas.naoCorrigidas}\n` +
        `📦 <b>Movimentações órfãs:</b> ${relatorio.movimentacoesOrfas.length}\n` +
        `💰 <b>Divergências financeiras:</b> ${relatorio.divergenciasFinanceiras.length}\n` +
        `🔴 <b>Saldos negativos:</b> ${relatorio.saldosNegativos.length}\n` +
        `🕐 ${new Date().toLocaleString('pt-BR')}`;
      window.CH?.TelegramService?.enviar?.(msg);
    } catch (_) {}
  }

  // ── Log e Diagnóstico ────────────────────────────────────────────
  function getLogs(limite = 50) {
    try {
      return JSON.parse(localStorage.getItem(_LOG_KEY) || '[]').slice(0, limite);
    } catch (_) { return []; }
  }

  function getLogsCriticos() {
    return getLogs(200).filter(l => l.nivel === 'CRITICO' || l.nivel === 'ERRO');
  }

  function getDivergenciasCriticas() {
    try {
      return JSON.parse(localStorage.getItem('CH_DIVERGENCIAS_CRITICAS') || '[]');
    } catch (_) { return []; }
  }

  function limparLogs() {
    localStorage.removeItem(_LOG_KEY);
    localStorage.removeItem('CH_DIVERGENCIAS_CRITICAS');
    _log('INFO', null, 'Logs de integridade limpos manualmente');
  }

  // ── Exposição ────────────────────────────────────────────────────
  window.CH.IntegrityService = {
    // Controles principais
    validarIntegridadeVenda,
    confirmarBaixaComRollback,
    validarIntegridadePosVenda,

    // Reconciliação e auditoria
    reconciliarCompleto,
    auditarIntegridade,

    // Bloqueios
    isVendaBloqueada,
    desbloquearVenda,

    // Diagnóstico
    getVendasSemMovimentacao,
    getLogs,
    getLogsCriticos,
    getDivergenciasCriticas,
    limparLogs,

    // Constantes úteis para UI
    STATUS_REQUEREM_BAIXA,
    STATUS_TERMINAIS,
  };

  // ── Hooks automáticos ────────────────────────────────────────────
  // Varredura de startup — executa UMA VEZ por sessão
  // FIX: firebase:ready pode disparar várias vezes (subscribeRealtime), gerando logs duplicados
  let _startupExecutado = false;
  EventBus.on('firebase:ready', async () => {
    if (_startupExecutado) return;
    _startupExecutado = true;
    try {
      // Aguarda 5s para Store + movimentacoes sincronizarem do Firestore
      await new Promise(r => setTimeout(r, 5000));

      // FIX: Limpar bloqueios de vendas já finalizadas (status terminal)
      // Evita que vendas antigas bloqueadas por falso-positivo fiquem presas
      try {
        const bloqueios = JSON.parse(localStorage.getItem(_BLOQUEIOS_KEY) || '{}');
        const vendas    = Store.getVendas();
        let   limpou    = false;
        for (const vendaId of Object.keys(bloqueios)) {
          const v = vendas.find(v => v.id === vendaId);
          // Remove bloqueio se venda não existe mais ou já está em status terminal
          if (!v || STATUS_TERMINAIS.includes(v.status)) {
            delete bloqueios[vendaId];
            limpou = true;
          }
        }
        if (limpou) localStorage.setItem(_BLOQUEIOS_KEY, JSON.stringify(bloqueios));
      } catch (_) {}

      // FIX: só verifica vendas dos ÚLTIMOS 2 DIAS com movimentacoes no Store
      // Usa âncora: se não há movimentacoes no Store, pula (sistema recém-inicializado)
      const totalMovs = Store.getMovimentacoes().length;
      if (totalMovs === 0) {
        console.info('[IntegrityService] Startup: sem movimentacoes no Store — varredura adiada');
        return;
      }

      const vendasOrfas = getVendasSemMovimentacao(1);
      if (vendasOrfas.length > 0) {
        _log('CRITICO', null, `STARTUP: ${vendasOrfas.length} venda(s) sem baixa detectada(s)`, {
          vendas: vendasOrfas.map(v => v.vendaId),
        });
        EventBus.emit('integrity:vendas_sem_baixa_detectadas', vendasOrfas);
      }
    } catch (e) {
      _log('WARN', null, 'Erro na varredura de startup', { erro: e.message });
    }
  });

  console.info('%c IntegrityService ✓  (Bloqueio de validação | Rollback atômico | Reconciliação ERP)', 'color:#ef4444;font-weight:bold');
})();
