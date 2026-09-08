/* =================================================================
   reveal.js - the results-screen entrance: numbers that shuffle from
   random digits into their real value.

   The frame builder is a pure function of (target, progress) so the
   settle order can be asserted in tests.html without waiting on a
   clock. Only the animator below touches the DOM.
   ================================================================= */

window.TT = window.TT || {};

(function (TT) {
  'use strict';

  const DIGITS = '0123456789';

  /* Everything before this point of the run is fully scrambled; after
     it, digits lock left to right, the last one landing exactly at 1. */
  const LOCK_START = 0.3;

  /* How often the random glyphs are re-rolled. Every frame reads as
     noise; ~24 rolls a second still reads as motion but stays legible. */
  const ROLL_MS = 42;

  const DEFAULT_DURATION = 520;

  function reducedMotion() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (err) {
      return false;
    }
  }

  function isDigit(ch) {
    return ch >= '0' && ch <= '9';
  }

  /**
   * The text to show partway through the shuffle.
   *
   * Only digits are replaced, so separators ('%', '/', '.', 's') hold
   * their place and the string never changes length - the layout cannot
   * jitter while the numbers spin.
   */
  function scrambleFrame(target, progress, random) {
    const text = String(target == null ? '' : target);
    const p = Math.min(1, Math.max(0, progress || 0));
    if (p >= 1) return text;

    const slots = [];
    for (let i = 0; i < text.length; i++) {
      if (isDigit(text[i])) slots.push(i);
    }
    if (slots.length === 0) return text;

    const rnd = random || Math.random;
    const out = text.split('');

    for (let k = 0; k < slots.length; k++) {
      const lockAt = LOCK_START + (1 - LOCK_START) * ((k + 1) / slots.length);
      if (p >= lockAt) continue;
      out[slots[k]] = DIGITS.charAt(Math.min(9, Math.floor(rnd() * 10)));
    }

    return out.join('');
  }

  /**
   * Shuffle `el` into `target`. Returns a cancel function that snaps
   * straight to the final text - call it before starting a new run so
   * two animations can never fight over the same element.
   */
  function scrambleText(el, target, opts) {
    const text = String(target == null ? '' : target);
    const noop = function () {};
    if (!el) return noop;

    const o = opts || {};
    const duration = o.duration === undefined ? DEFAULT_DURATION : o.duration;
    const delay = o.delay || 0;

    if (!(duration > 0) || reducedMotion()) {
      el.textContent = text;
      return noop;
    }

    const start = performance.now() + delay;
    let raf = 0;
    let rolledAt = -Infinity;
    let frame = scrambleFrame(text, 0, o.random);
    el.textContent = frame;

    function step(now) {
      const p = (now - start) / duration;

      if (p >= 1) {
        el.textContent = text;
        raf = 0;
        return;
      }

      if (now - rolledAt >= ROLL_MS) {
        rolledAt = now;
        frame = scrambleFrame(text, p, o.random);
      }

      el.textContent = frame;
      raf = requestAnimationFrame(step);
    }

    raf = requestAnimationFrame(step);

    return function cancel() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      el.textContent = text;
    };
  }

  TT.reveal = { scrambleFrame, scrambleText, reducedMotion, LOCK_START, DEFAULT_DURATION };
})(window.TT);
