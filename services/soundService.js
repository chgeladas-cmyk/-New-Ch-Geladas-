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
 * Volume ajustável por loja via Config.somVolume (0–2, padrão 1).
 */
(function () {
  window.CH = window.CH || {};

  let _ctx = null;
  let _master = null; // gain + compressor compartilhados, pra deixar mais alto sem estourar
  function _getCtx() {
    if (_ctx) return _ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { _ctx = new AC(); } catch (_) { _ctx = null; }
    return _ctx;
  }

  function _getMaster(ctx) {
    if (_master) return _master;
    const comp = ctx.createDynamicsCompressor();
    // Compressor "agressivo" — segura o pico e deixa o som médio bem mais alto
    comp.threshold.setValueAtTime(-24, ctx.currentTime);
    comp.knee.setValueAtTime(20, ctx.currentTime);
    comp.ratio.setValueAtTime(12, ctx.currentTime);
    comp.attack.setValueAtTime(0.003, ctx.currentTime);
    comp.release.setValueAtTime(0.15, ctx.currentTime);

    const vol = ctx.createGain();
    // FIX (jul/2026): pedido explícito de "som alto" na conclusão da venda.
    // Volume base subiu de 1 para 1.6 — o compressor acima já segura o pico
    // pra não estourar/distorcer mesmo nesse volume maior.
    let volume = 1.6;
    try {
      const cfg = window.CH?.Store?.getConfig?.();
      if (typeof cfg?.somVolume === 'number') volume = cfg.somVolume; // 0–2, config opcional por loja
    } catch (_) {}
    vol.gain.setValueAtTime(volume, ctx.currentTime);

    vol.connect(comp);
    comp.connect(ctx.destination);
    _master = vol;
    return _master;
  }

  function _tone(ctx, freq, start, duration, { gain = 0.4, type = 'sine' } = {}) {
    const osc = ctx.createOscillator();
    const g   = ctx.createGain();
    osc.type  = type;
    osc.frequency.setValueAtTime(freq, start);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(gain, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(g).connect(_getMaster(ctx));
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  function _somAtivo() {
    try {
      const cfg = window.CH?.Store?.getConfig?.();
      return cfg?.somAtivo !== false; // default: ativado
    } catch (_) { return true; }
  }

  // "Cha-ching" — três tons ascendentes, cada um com uma oitava dobrada
  // por cima pra dar corpo/volume percebido sem distorcer.
  // FIX (jul/2026): ganhos maiores + terceira nota final pra ficar mais
  // alto e chamativo na conclusão da venda (pedido explícito do usuário).
  function _somVenda(ctx) {
    const t = ctx.currentTime;
    _tone(ctx, 880,    t,        0.14, { gain: 0.75, type: 'triangle' });
    _tone(ctx, 880*2,  t,        0.10, { gain: 0.35, type: 'triangle' });
    _tone(ctx, 1318.5, t + 0.09, 0.22, { gain: 0.85, type: 'triangle' });
    _tone(ctx, 1318.5*2, t+0.09, 0.14, { gain: 0.32, type: 'triangle' });
    _tone(ctx, 1760,   t + 0.20, 0.28, { gain: 0.9,  type: 'triangle' });
    _tone(ctx, 1760*2, t + 0.20, 0.16, { gain: 0.30, type: 'triangle' });
  }

  // Tom grave duplo — erro/cancelamento
  function _somErro(ctx) {
    const t = ctx.currentTime;
    _tone(ctx, 220, t,        0.18, { gain: 0.45, type: 'sawtooth' });
    _tone(ctx, 180, t + 0.12, 0.22, { gain: 0.45, type: 'sawtooth' });
  }

  // Bipe curto neutro — aviso genérico
  function _somAviso(ctx) {
    _tone(ctx, 660, ctx.currentTime, 0.12, { gain: 0.35, type: 'sine' });
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
