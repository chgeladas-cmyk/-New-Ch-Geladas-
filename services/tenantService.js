'use strict';
/**
 * services/tenantService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Resolve o `empresaId` (identificador de tenant/empresa) usado em todo
 * registro econômico novo (CompraLote, MovimentacaoLote, rentabilidade).
 *
 * CONTEXTO IMPORTANTE (ver análise arquitetural):
 *   O PDV do CH Geladas roda hoje single-tenant — AuthService (core.js)
 *   não tem nenhum conceito de empresa/tenant. Existe um produto SEPARADO
 *   (services/saasService.js) com login multi-empresa de verdade, mas ele
 *   usa outro modelo de dados (saas_dados/{empresaId}/...) e não está
 *   ligado a este PDV.
 *
 *   Reescrever a autenticação/dados de todo o PDV pra rodar sob o modelo
 *   multi-tenant do SaaS é um projeto à parte — arriscado demais pra
 *   misturar com a feature de rastreabilidade de lote. Decisão tomada:
 *
 *   → Todo registro novo (lote, movimentação de lote) já nasce com um
 *     campo `empresaId` de verdade, resolvido por este serviço.
 *   → Se este PDV algum dia rodar sob login do saasService, este serviço
 *     passa a devolver o empresaId real da sessão SaaS automaticamente
 *     (prioridade 1 abaixo) — nenhum dado de lote precisa ser migrado.
 *   → Enquanto isso não acontece, resolve um empresaId ESTÁVEL e único
 *     pra esta instalação, gerado uma vez e guardado no mesmo doc
 *     `config` que o resto do sistema já usa (Store.mutateConfig) —
 *     mesmo padrão usado em documentos.html pra logo/CNPJ da loja.
 *
 * Requer: core.js carregado antes.
 */

(function () {
  const { Store, Utils, EventBus } = window.CH;

  let _empresaIdCache = null;

  /** Gera um slug estável a partir do nome da loja + um sufixo aleatório curto */
  function _gerarEmpresaIdLocal() {
    const cfg   = Store.getConfig() || {};
    const nome  = (cfg.documentos?.nome || cfg.nome || 'ch-geladas').trim();
    const slug  = nome
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 40) || 'empresa';
    const sufixo = Utils.generateId().slice(0, 8);
    return `${slug}-${sufixo}`;
  }

  /**
   * Retorna o empresaId atual. Prioridade:
   *   1) Sessão ativa do saasService (se este PDV algum dia rodar sob ele)
   *   2) empresaId já gerado e persistido em cfg.tenant.empresaId
   *   3) Gera um novo, persiste, e retorna
   *
   * Síncrono de propósito (é lido com frequência em cálculos de FIFO/CMV;
   * não pode depender de await em todo lugar que precisa do empresaId).
   * A geração (passo 3) só acontece uma vez por instalação — depois disso
   * sempre cai no passo 2 (leitura simples do config já em cache).
   */
  function getEmpresaId() {
    // 1) SaaS real, se algum dia estiver logado nesta sessão
    const saas = window.CH?.SaaSService;
    if (saas?.isLogged?.()) {
      const id = saas.getEmpresaId?.();
      if (id) return id;
    }

    // 2) Cache em memória (evita reler o config toda hora)
    if (_empresaIdCache) return _empresaIdCache;

    // 3) Config persistido
    const cfg = Store.getConfig() || {};
    if (cfg.tenant?.empresaId) {
      _empresaIdCache = cfg.tenant.empresaId;
      return _empresaIdCache;
    }

    // 4) Nunca gerado nesta instalação — gera e persiste agora
    const novoId = _gerarEmpresaIdLocal();
    _empresaIdCache = novoId;
    Store.mutateConfig(c => { c.tenant = { ...(c.tenant||{}), empresaId: novoId, origem: 'local', geradoEm: Utils.nowISO() }; });
    console.info('[TenantService] empresaId gerado para esta instalação:', novoId);
    EventBus.emit('tenant:empresaId-gerado', novoId);
    return novoId;
  }

  /** Limpa o cache em memória — usar após login/logout do saasService ou reset de config */
  function invalidateCache() { _empresaIdCache = null; }

  window.CH = window.CH || {};
  window.CH.TenantService = { getEmpresaId, invalidateCache };
  console.info('%c tenantService ✓', 'color:#64748b');
})();
