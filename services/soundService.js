'use strict';
/**
 * services/soundService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Efeitos sonoros via Web Audio API (osciladores) — sem arquivos de
 * áudio externos, funciona offline/PWA.
 *
 * Uso:
 *   window.CH.SoundService.play('venda')  // "cha-ching" ao concluir venda
 *   window.CH.SoundService.play('erro')   // tom grave descendente
 *   window.CH.SoundService.play('aviso')  // bipe curto neutro
 *   window.CH.SoundService.beep()         // alias de 'aviso'
 *
 * Pode ser desativado por loja via Config.somAtivo === false.
 */
(function () {
  window.CH = window.CH || {};

  let _ctx = null;
  function _getCtx() {
    if (_ctx) return _ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { _ctx = new AC(); } catch (_) { _ctx = null; }
    return _ctx;
  }

  function _tone(ctx, freq, start, duration, { gain = 0.15, type = 'sine' } = {}) {
    const osc = ctx.createOscillator();
    const g   = ctx.createGain();
    osc.type  = type;
    osc.frequency.setValueAtTime(freq, start);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(gain, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(g).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  function _somAtivo() {
    try {
      const cfg = window.CH?.Store?.getConfig?.();
      return cfg?.somAtivo !== false; // default: ativado
    } catch (_) { return true; }
  }

  // "Cha-ching" — dois tons curtos ascendentes
  function _somVenda(ctx) {
    const t = ctx.currentTime;
    _tone(ctx, 880,    t,       0.12, { gain: 0.12, type: 'triangle' });
    _tone(ctx, 1318.5, t + 0.09, 0.18, { gain: 0.14, type: 'triangle' });
  }

  // Tom grave duplo — erro/cancelamento
  function _somErro(ctx) {
    const t = ctx.currentTime;
    _tone(ctx, 220, t,        0.15, { gain: 0.12, type: 'sawtooth' });
    _tone(ctx, 180, t + 0.12, 0.18, { gain: 0.12, type: 'sawtooth' });
  }

  // Bipe curto neutro — aviso genérico
  function _somAviso(ctx) {
    _tone(ctx, 660, ctx.currentTime, 0.1, { gain: 0.10, type: 'sine' });
  }

  function play(tipo = 'venda') {
    if (!_somAtivo()) return;
    const ctx = _getCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    try {
      if (tipo === 'erro')       _somErro(ctx);
      else if (tipo === 'aviso') _somAviso(ctx);
      else                       _somVenda(ctx); // 'venda' e default
    } catch (e) {
      console.warn('[SoundService] falha ao tocar som:', e.message);
    }
  }

  function beep() { play('aviso'); }

  window.CH.SoundService = { play, beep };
  console.info('%c SoundService ✓  (Web Audio — sem arquivos externos)', 'color:#10b981');
})();
