/* =================================================================
   engine.js - the typing state machine.

   Owns the target words, what has been typed, and the clock. Knows
   nothing about the DOM: it emits events and the renderer reacts.

   Timing note: elapsed time is always recomputed as
   (now - startTime), never accumulated tick by tick. The interval
   only decides *when* to look at the clock, never what it says.

   Events: rebuild | append | start | key | paint | tick | finish
   ================================================================= */

window.TT = window.TT || {};

(function (TT) {
  'use strict';

  const TICK_MS = 100;
  const EXTRA_LIMIT = 10;        // max characters typed past the end of a word
  const INITIAL_TIME_WORDS = 60; // starting pool in time mode
  const REFILL_BATCH = 40;       // words appended per refill
  const LOW_WATER = 20;          // refill once this few words remain

  function createEngine() {
    const listeners = Object.create(null);

    let config = {
      mode: 'time',
      modeValue: 30,
      punctuation: false,
      numbers: false
    };

    const state = {
      words: [],
      typed: [''],
      wordIndex: 0,
      startTime: null,
      endTime: null,
      running: false,
      finished: false,
      keystrokes: { correct: 0, incorrect: 0 },
      samples: []
    };

    let timerId = null;
    let lastSampleTotal = 0;   // typed-character count at the previous sample
    let errorsThisSecond = 0;
    let nextSampleAt = 1;      // next whole second to sample

    /* ------------------------------ events ------------------------------ */

    function on(name, fn) {
      (listeners[name] || (listeners[name] = [])).push(fn);
      return () => off(name, fn);
    }

    function off(name, fn) {
      const list = listeners[name];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    }

    function emit(name, payload) {
      const list = listeners[name];
      if (!list) return;
      for (let i = 0; i < list.length; i++) list[i](payload);
    }

    /* ------------------------------ clock ------------------------------ */

    /* 'time' and '1 word' both end on the clock; 'words' ends on a count. */
    const timed = () => TT.storage.isTimed(config.mode);

    /* '1 word' shows one word at a time, so there is nothing to scroll
       back to and no passage to read ahead in. */
    const single = () => config.mode === 'single';

    function elapsed() {
      if (state.startTime == null) return 0;
      const end = state.endTime != null ? state.endTime : performance.now();
      const seconds = (end - state.startTime) / 1000;
      /* A timed mode must never report more than its configured duration,
         so the final numbers land exactly on 15s / 30s / 60s / 120s. */
      if (timed()) return Math.min(seconds, config.modeValue);
      return seconds;
    }

    function remaining() {
      if (!timed()) return 0;
      return Math.max(0, config.modeValue - elapsed());
    }

    function stopTimer() {
      if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
      }
    }

    /* Push one point onto the chart series. `raw` is the characters typed
       during this window alone, expressed per minute. */
    function sample(atSecond, windowSeconds) {
      const counts = TT.stats.countChars(state.words, state.typed, state.wordIndex);
      const deltaChars = Math.max(0, counts.typedTotal - lastSampleTotal);
      lastSampleTotal = counts.typedTotal;

      state.samples.push({
        t: Math.round(atSecond * 10) / 10,
        raw: windowSeconds > 0 ? (deltaChars / 5) / (windowSeconds / 60) : 0,
        wpm: TT.stats.wpm(counts.correctWithSpaces, atSecond),
        errors: errorsThisSecond
      });

      errorsThisSecond = 0;
    }

    function onTick() {
      if (!state.running) return;
      const t = elapsed();

      while (t >= nextSampleAt) {
        sample(nextSampleAt, 1);
        nextSampleAt += 1;
      }

      if (timed() && t >= config.modeValue) {
        finish();
        return;
      }

      emit('tick');
    }

    function begin() {
      if (state.running || state.finished) return;
      state.running = true;
      state.startTime = performance.now();
      state.endTime = null;
      nextSampleAt = 1;
      lastSampleTotal = 0;
      errorsThisSecond = 0;
      timerId = setInterval(onTick, TICK_MS);
      emit('start');
    }

    /* ------------------------------ words ------------------------------ */

    function ensureWords() {
      /* Only a timed mode can outrun its word pool. */
      if (!timed()) return;
      if (state.words.length - state.wordIndex > LOW_WATER) return;

      const more = TT.words.generate(REFILL_BATCH, config);
      const from = state.words.length;
      state.words = state.words.concat(more);
      emit('append', { from, words: more });
    }

    function reset(nextConfig) {
      stopTimer();
      if (nextConfig) config = Object.assign({}, config, nextConfig);

      const count = timed() ? INITIAL_TIME_WORDS : config.modeValue;

      state.words = TT.words.generate(count, config);
      state.typed = [''];
      state.wordIndex = 0;
      state.startTime = null;
      state.endTime = null;
      state.running = false;
      state.finished = false;
      state.keystrokes = { correct: 0, incorrect: 0 };
      state.samples = [];

      lastSampleTotal = 0;
      errorsThisSecond = 0;
      nextSampleAt = 1;

      emit('rebuild');
      emit('tick');
    }

    /* ------------------------------ input ------------------------------ */

    /* Move to the next word. The separator is credited from the word
       index rather than from a space keystroke, so a word committed by
       auto-advance counts exactly like one committed by pressing space
       and the wpm stays comparable across modes. */
    function advanceWord() {
      const previous = state.wordIndex;
      state.wordIndex++;
      if (state.typed.length <= state.wordIndex) state.typed.push('');

      ensureWords();
      emit('paint', { indexes: [previous, state.wordIndex] });
    }

    function typeChar(ch) {
      if (state.finished || typeof ch !== 'string' || ch.length !== 1) return;
      if (ch === ' ') return typeSpace();

      begin();

      const target = state.words[state.wordIndex] || '';
      const current = state.typed[state.wordIndex] || '';

      /* A stuck key must not be able to grow the DOM without bound. */
      if (current.length >= target.length + EXTRA_LIMIT) return;

      /* charAt past the end returns the empty string, which a single
         character can never equal, so overtyping always counts wrong. */
      const correct = ch === target.charAt(current.length);
      if (correct) {
        state.keystrokes.correct++;
      } else {
        state.keystrokes.incorrect++;
        errorsThisSecond++;
      }

      state.typed[state.wordIndex] = current + ch;
      emit('key', { correct });
      emit('paint', { indexes: [state.wordIndex] });

      /* '1 word' has no space to press: finishing the word is what
         commits it. Only an exact match advances, so a word with a
         mistake in it stays put until it is corrected.

         This also means a correct word can never be overtyped - it is
         gone before the next character lands. */
      if (single() && state.typed[state.wordIndex] === target) {
        advanceWord();
        emit('tick');
        return;
      }

      /* Words mode ends the instant the last word is completed - no
         trailing space required. */
      if (config.mode === 'words' &&
          state.wordIndex === state.words.length - 1 &&
          state.typed[state.wordIndex] === target) {
        finish();
        return;
      }

      emit('tick');
    }

    function typeSpace() {
      if (state.finished) return;

      const current = state.typed[state.wordIndex] || '';
      /* A leading space is a no-op and must not start the clock. */
      if (!state.running && current.length === 0) return;

      /* In '1 word' the word has already committed itself, so a space
         out of habit would arrive on the fresh word and skip it unseen.
         On a word you have started, space still works as the usual
         give-up-and-move-on. */
      if (single() && current.length === 0) return;

      begin();

      const target = state.words[state.wordIndex] || '';
      /* The separator counts as correct only when the word it closes
         was typed exactly right. */
      const correct = current === target;
      if (correct) {
        state.keystrokes.correct++;
      } else {
        state.keystrokes.incorrect++;
        errorsThisSecond++;
      }
      emit('key', { correct });

      if (config.mode === 'words' && state.wordIndex === state.words.length - 1) {
        finish();
        return;
      }

      advanceWord();
      emit('tick');
    }

    function backspace(wholeWord) {
      if (state.finished) return;

      const current = state.typed[state.wordIndex] || '';

      if (current.length === 0) {
        if (state.wordIndex === 0) return;

        /* In '1 word' the previous word is gone from the screen. Letting
           the caret walk back into a word nobody can see would be a
           silent trap, so the word boundary is final here. */
        if (single()) return;

        /* Cross back into the previous word only when it still holds a
           mistake - a perfectly typed word is locked in. */
        const prevIndex = state.wordIndex - 1;
        if ((state.typed[prevIndex] || '') === state.words[prevIndex]) return;

        state.typed.length = state.wordIndex; // drop the empty current entry
        state.wordIndex = prevIndex;
        if (wholeWord) state.typed[prevIndex] = '';

        emit('paint', { indexes: [prevIndex, prevIndex + 1] });
        emit('tick');
        return;
      }

      state.typed[state.wordIndex] = wholeWord ? '' : current.slice(0, -1);
      emit('paint', { indexes: [state.wordIndex] });
      emit('tick');
    }

    /* ----------------------------- results ----------------------------- */

    function liveStats() {
      const counts = TT.stats.countChars(state.words, state.typed, state.wordIndex);
      const t = elapsed();
      return {
        counts,
        elapsed: t,
        wpm: TT.stats.wpm(counts.correctWithSpaces, t),
        raw: TT.stats.raw(counts.typedTotal, t),
        accuracy: TT.stats.accuracy(state.keystrokes.correct, state.keystrokes.incorrect)
      };
    }

    function buildResult() {
      const live = liveStats();
      return {
        ts: Date.now(),
        mode: config.mode,
        modeValue: config.modeValue,
        punctuation: !!config.punctuation,
        numbers: !!config.numbers,
        wpm: live.wpm,
        raw: live.raw,
        accuracy: live.accuracy,
        consistency: TT.stats.consistency(state.samples.map((s) => s.raw)),
        duration: live.elapsed,
        chars: {
          correct: live.counts.correct,
          incorrect: live.counts.incorrect,
          extra: live.counts.extra,
          missed: live.counts.missed
        },
        samples: state.samples.slice()
      };
    }

    function finish() {
      if (state.finished) return;

      stopTimer();
      state.endTime = performance.now();
      state.running = false;
      state.finished = true;

      /* Close out the partial second the test ended on, so the graph
         does not stop short of the real finish. */
      const t = elapsed();
      const partial = t - (nextSampleAt - 1);
      if (partial > 0.2) sample(t, partial);

      emit('finish', buildResult());
    }

    return {
      on,
      off,
      state,
      reset,
      typeChar,
      typeSpace,
      backspace,
      finish,
      elapsed,
      remaining,
      liveStats,
      getConfig: () => Object.assign({}, config),
      isSingle: single,
      isTimed: timed,
      isRunning: () => state.running,
      isFinished: () => state.finished
    };
  }

  TT.createEngine = createEngine;
})(window.TT);
