'use strict';
/* featureFlagsService.js — stub standalone
 * Esses serviços (filial, whitelabel, billing, featureFlags) foram
 * removidos da versão standalone do CH Geladas. Este stub evita os
 * erros 404 e garante que o dashboard funcione sem eles. */
(function () {
  window.CH = window.CH || {};
  window.CH.FeatureFlags = {
    planoAtual:   () => '_standalone',
    habilitado:   () => true,
    getFlag:      () => true,
  };
  console.info('%c featureFlagsService ✓ (stub standalone)', 'color:#64748b');
})();
