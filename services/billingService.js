'use strict';
/* billingService.js — stub standalone */
(function () {
  window.CH = window.CH || {};
  window.CH.BillingService = {
    getPlano:   () => '_standalone',
    getLimites: () => ({ vendas: Infinity, produtos: Infinity }),
    isAtivo:    () => true,
  };
  console.info('%c billingService ✓ (stub standalone)', 'color:#64748b');
})();
