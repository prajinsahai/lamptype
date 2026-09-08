/* =================================================================
   stats.js - all the arithmetic, as pure functions.

   Nothing here touches the DOM or the engine state, which is what
   makes tests.html able to assert against it directly.

   Definitions (matching Monkeytype):
     wpm         = (correct characters / 5) / minutes
     raw         = (all typed characters / 5) / minutes
     accuracy    = correct keystrokes / all keystrokes
                   -- a running tally, NOT recomputed from final text,
                   so a mistake you later fix still costs accuracy
     consistency = 100 * (1 - stdev / mean) over per-second raw wpm
   ================================================================= */

window.TT = window.TT || {};

(function (TT) {
  'use strict';

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  function mean(values) {
    if (!values.length) return 0;
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[i];
    return sum / values.length;
  }

  /* Population standard deviation. */
  function stdev(values) {
    if (values.length < 2) return 0;
    const m = mean(values);
    let acc = 0;
    for (let i = 0; i < values.length; i++) {
      const d = values[i] - m;
      acc += d * d;
    }
    return Math.sqrt(acc / values.length);
  }

  /**
   * Classify every character the typist has produced.
   *
   * @param {string[]} words       the target words
   * @param {string[]} typed       what was actually typed, per word
   * @param {number}   separators  spaces committed so far (= current word index)
   */
  function countChars(words, typed, separators) {
    const seps = Math.max(0, Math.floor(separators) || 0);
    let correct = 0;
    let incorrect = 0;
    let extra = 0;
    let missed = 0;
    let typedTotal = 0;
    let correctSeparators = 0;

    for (let i = 0; i < typed.length; i++) {
      const target = words[i] || '';
      const got = typed[i] || '';
      typedTotal += got.length;

      const shared = Math.min(target.length, got.length);
      for (let j = 0; j < shared; j++) {
        if (got.charAt(j) === target.charAt(j)) correct++;
        else incorrect++;
      }

      if (got.length > target.length) {
        extra += got.length - target.length;
      } else if (got.length < target.length && i < seps) {
        /* Only words the typist moved past count as missed; the word
           under the caret is merely unfinished. */
        missed += target.length - got.length;
      }

      if (i < seps && got === target) correctSeparators++;
    }

    return {
      correct,
      incorrect,
      extra,
      missed,
      /* The space after a perfectly typed word is itself a correct character. */
      correctWithSpaces: correct + correctSeparators,
      typedTotal: typedTotal + seps
    };
  }

  function wpm(correctChars, elapsedSeconds) {
    if (!(elapsedSeconds > 0)) return 0;
    return (correctChars / 5) / (elapsedSeconds / 60);
  }

  function raw(allChars, elapsedSeconds) {
    if (!(elapsedSeconds > 0)) return 0;
    return (allChars / 5) / (elapsedSeconds / 60);
  }

  /* Returns 100 when nothing has been typed: this drives the live
     readout, and "0%" before the first keypress reads as failure. */
  function accuracy(correctKeystrokes, incorrectKeystrokes) {
    const total = correctKeystrokes + incorrectKeystrokes;
    if (total <= 0) return 100;
    return (correctKeystrokes / total) * 100;
  }

  /**
   * How even the typing speed was, from the per-second raw wpm series.
   * A flat series scores 100; a spiky one drops toward 0.
   */
  function consistency(samples) {
    const values = (samples || []).filter((v) => typeof v === 'number' && isFinite(v));
    if (values.length < 2) return 100;
    const m = mean(values);
    if (m <= 0) return 0;
    return clamp(100 * (1 - stdev(values) / m), 0, 100);
  }

  TT.stats = { clamp, mean, stdev, countChars, wpm, raw, accuracy, consistency };
})(window.TT);
