/* =================================================================
   race.js - the AI opponent.

   The opponent does not type. It only needs a position in the
   passage, so it is a character counter advanced by elapsed time.

   How fast it goes:

     races 1-5   a random speed from a plausible band. There is not
                 enough of a picture of the typist yet to calibrate
                 against, and guessing badly early is what makes an
                 opponent feel unfair.

     race 6+     the typist's own recent average, plus a ramp that
                 grows 2% per race to a ceiling of +20%. So the first
                 calibrated race is a dead heat and it tightens from
                 there, but it never runs away.

   The ramp is capped deliberately: an opponent that keeps getting
   faster forever stops being a competition and becomes a wall.
   ================================================================= */

window.TT = window.TT || {};

(function (TT) {
  'use strict';

  const RACE_UNLOCK = 5;    // races before calibration takes over
  const WARMUP_MIN = 32;    // wpm band used while still learning
  const WARMUP_MAX = 78;
  const RAMP_STEP = 0.02;   // +2% per race once calibrated
  const RAMP_CAP = 0.20;    // never more than +20% over the average
  const JITTER = 0.08;      // +/-8% so no two races feel identical
  const FLOOR = 18;         // never absurdly slow
  const CEILING = 160;      // never absurdly fast
  const SAMPLE = 10;        // how many recent runs form the average
  const WOBBLE = 0.10;      // in-race speed variation, +/-10%

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /* The typist's recent form. Older runs are ignored so the opponent
     tracks who you are now rather than who you were. */
  function averageWpm(history, sample) {
    const runs = (history || [])
      .filter((r) => r && typeof r.wpm === 'number' && isFinite(r.wpm) && r.wpm > 0)
      .slice(0, sample || SAMPLE);

    if (runs.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < runs.length; i++) sum += runs[i].wpm;
    return sum / runs.length;
  }

  /**
   * Pick the opponent's speed for the next race.
   *
   * @param {object} opts
   * @param {number} opts.average          the typist's recent average wpm
   * @param {number} opts.racesCompleted   how many races are behind them
   * @param {function} [opts.random]       injectable for tests
   */
  function opponentWpm(opts) {
    const o = opts || {};
    const rnd = o.random || Math.random;
    const races = Math.max(0, Math.floor(o.racesCompleted) || 0);
    const average = o.average;

    /* Not enough of a picture yet - or no usable history at all. */
    if (races < RACE_UNLOCK || !(average > 0)) {
      return WARMUP_MIN + rnd() * (WARMUP_MAX - WARMUP_MIN);
    }

    const ramp = Math.min(RAMP_CAP, (races - RACE_UNLOCK) * RAMP_STEP);
    const jitter = 1 + (rnd() * 2 - 1) * JITTER;
    return clamp(average * (1 + ramp) * jitter, FLOOR, CEILING);
  }

  /* Characters in the passage, counting the single space between
     each pair of words. */
  function totalChars(words) {
    if (!words || words.length === 0) return 0;
    let n = 0;
    for (let i = 0; i < words.length; i++) n += words[i].length;
    return n + words.length - 1;
  }

  /* How far through the passage the caret sits, in characters.
     Skipped words still count their full length: this measures
     position in the text, not correctness. */
  function caretPosition(words, typed, wordIndex) {
    if (!words || words.length === 0) return 0;
    const upto = Math.min(wordIndex, words.length);
    let n = 0;
    for (let i = 0; i < upto; i++) n += words[i].length + 1;
    n += ((typed && typed[upto]) || '').length;
    return Math.min(n, totalChars(words));
  }

  /**
   * A running opponent, as a pure function of elapsed race time.
   *
   * The speed wobbles gently around the target so the opponent reads as
   * a person rather than a metronome, but position is the closed-form
   * integral of that speed rather than an accumulation of frame deltas:
   *
   *   speed(t)    = cps * (1 + W*sin(2*pi*t/P + phase))
   *   position(t) = cps * (t - (W*P/2pi) * (cos(2*pi*t/P + phase) - cos(phase)))
   *
   * That matters for fairness. Your own wpm is measured against the wall
   * clock, so an opponent built from accumulated frame deltas falls behind
   * whenever the browser drops frames - a stalled tab, a slow machine, a
   * background window - and you would win races you did not earn. Sharing
   * one clock keeps both racers on the same footing, and makes the
   * opponent exactly testable.
   */
  function createOpponent(wpm) {
    const charsPerSecond = (wpm * 5) / 60;
    const phase = Math.random() * Math.PI * 2;
    const period = 3 + Math.random() * 3; // 3-6 seconds per wobble cycle
    const amplitude = (WOBBLE * period) / (2 * Math.PI);

    return {
      wpm,
      positionAt(elapsedSeconds) {
        const t = Math.max(0, elapsedSeconds || 0);
        const swing = Math.cos((2 * Math.PI * t) / period + phase) - Math.cos(phase);
        return charsPerSecond * (t - amplitude * swing);
      }
    };
  }

  TT.race = {
    RACE_UNLOCK,
    WARMUP_MIN,
    WARMUP_MAX,
    RAMP_CAP,
    FLOOR,
    CEILING,
    averageWpm,
    opponentWpm,
    totalChars,
    caretPosition,
    createOpponent
  };
})(window.TT);
