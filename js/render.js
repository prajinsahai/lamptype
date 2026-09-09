/* =================================================================
   render.js - painting the words, the caret, and the line scroll.

   The word spans are built once per test. Every keystroke touches
   only the letters of the word that actually changed; re-rendering
   the whole passage per keypress is what makes typing clones feel
   laggy, so it is deliberately avoided here.
   ================================================================= */

window.TT = window.TT || {};

(function (TT) {
  'use strict';

  const VISIBLE_LINES = 3;
  const CARET_IDLE_MS = 1000;

  /* Caret smoothing. The caret chases its target on an exponential curve
     driven by requestAnimationFrame rather than by a CSS transition,
     because a transition restarted on every keystroke re-eases from
     wherever it had got to - which is what makes fast typing look like it
     is stuttering. An exponential approach has no restart and no velocity
     discontinuity: it is simply always heading for the latest target. */
  const CARET_TAU = 0.030;    // seconds to close ~63% of the gap
  const CARET_SNAP_PX = 72;   // a jump this big is a new line or a new word
  const CARET_DONE_PX = 0.05; // close enough to stop the loop
  const CARET_MAX_DT = 0.05;

  /* Frame-rate independent: the same curve whether frames arrive at 60Hz,
     144Hz or irregularly. */
  function approach(current, target, dt, tau) {
    if (!(tau > 0)) return target;
    return current + (target - current) * (1 - Math.exp(-dt / tau));
  }

  /* Smoothing forward across a line is the point. Sliding the caret
     backwards across a whole line on a wrap, or across a word swap in
     '1 word', is not - those want to be instant. */
  function shouldSnap(dx, dy) {
    return Math.abs(dy) > 0.5 || Math.abs(dx) > CARET_SNAP_PX;
  }

  function createRenderer(dom, engine) {
    const wordEls = [];
    let lineHeight = 0;
    let scrolledLines = 0;
    let caretTimer = null;
    let resizeFrame = null;
    let activeEl = null;   // the shown word in '1 word' mode

    /* Where the caret is drawn, and where it is heading. */
    const caretAt = { x: 0, y: 0, h: 0 };
    const caretTo = { x: 0, y: 0, h: 0 };
    let caretPlaced = false;
    let caretRaf = null;
    let caretLast = 0;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    function makeWordEl(word) {
      const el = document.createElement('div');
      el.className = 'word';
      for (let i = 0; i < word.length; i++) {
        const span = document.createElement('span');
        span.className = 'letter';
        span.textContent = word.charAt(i);
        el.appendChild(span);
      }
      return el;
    }

    /* In '1 word' only the current word is on screen. Everything else is
       still built and still in the DOM - it is simply not displayed -
       so the caret, the stats and the refill all work unchanged. */
    function showOnly(index) {
      const next = wordEls[index];
      if (next === activeEl) return;
      if (activeEl) activeEl.classList.remove('active');
      activeEl = next || null;
      if (activeEl) activeEl.classList.add('active');
      /* The swap runs on the container, not on the word: a transform on
         the word would make it the caret's offsetParent and the caret
         would measure its position against the wrong element. */
      replay(dom.words);
    }

    /* Restart a CSS animation on an element that is staying put. */
    function replay(el) {
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
    }

    /* Where a letter sits inside the words container, in real fractional
       pixels.

       This used to walk the offsetParent chain adding up offsetLeft, and
       offsetLeft is rounded to whole pixels at every hop. Against a
       proportional serif whose advances land on fractions - 25.03, 16.39,
       11.86 - that rounding moved the caret in uneven whole-pixel steps
       and read as jitter. Rects are fractional, so the caret now lands
       exactly where the glyph does. */
    function rectWithin(el) {
      const a = el.getBoundingClientRect();
      const b = dom.words.getBoundingClientRect();
      return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height };
    }

    /* Row pitch measured from the DOM rather than assumed from CSS, so
       it stays right across font sizes, zoom levels and themes. */
    function measure() {
      if (wordEls.length === 0) return;
      const base = wordEls[0].offsetTop;
      let pitch = 0;
      for (let i = 1; i < wordEls.length; i++) {
        if (wordEls[i].offsetTop > base) {
          pitch = wordEls[i].offsetTop - base;
          break;
        }
      }
      const measured = pitch || wordEls[0].offsetHeight;

      /* A hidden or not-yet-laid-out container measures as zero. Keep the
         previous height rather than collapsing the area to nothing. */
      if (measured <= 0) return;

      lineHeight = measured;
      /* One word, one line. The area keeps its min-height from CSS so the
         page does not jump when the mode changes. */
      const lines = engine.isSingle() ? 1 : VISIBLE_LINES;
      dom.area.style.height = (lineHeight * lines) + 'px';

      /* The offset is stored in lines but written in pixels, so a new row
         pitch - a resize across a breakpoint, a font that finished
         loading - has to be pushed back out or the passage stays parked
         at the old line height. */
      applyScroll();
    }

    function applyScroll() {
      dom.words.style.transform = 'translateY(' + (-scrolledLines * lineHeight) + 'px)';
    }

    function rebuild() {
      wordEls.length = 0;
      dom.words.textContent = '';
      /* The caret is absolutely positioned, so it sits inside .words
         (and rides the scroll transform) without joining the flex flow. */
      dom.words.appendChild(dom.caret);

      const frag = document.createDocumentFragment();
      const words = engine.state.words;
      for (let i = 0; i < words.length; i++) {
        const el = makeWordEl(words[i]);
        wordEls.push(el);
        frag.appendChild(el);
      }
      dom.words.appendChild(frag);

      activeEl = null;
      dom.words.classList.toggle('single', engine.isSingle());
      /* The container survives a rebuild, so the entrance animation has
         to be restarted by hand. */
      replay(dom.words);
      if (engine.isSingle()) showOnly(engine.state.wordIndex);

      scrolledLines = 0;
      applyScroll();
      measure();
      caretPlaced = false;   // a new passage places the caret outright
      updateCaret();
    }

    function append(words) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < words.length; i++) {
        const el = makeWordEl(words[i]);
        wordEls.push(el);
        frag.appendChild(el);
      }
      dom.words.appendChild(frag);
    }

    function paintWord(index) {
      const el = wordEls[index];
      if (!el) return;

      const target = engine.state.words[index] || '';
      const got = engine.state.typed[index] || '';
      const letters = el.children; // live collection
      const needed = Math.max(target.length, got.length);

      while (letters.length < needed) {
        const span = document.createElement('span');
        span.className = 'letter extra';
        el.appendChild(span);
      }
      while (letters.length > needed) {
        el.removeChild(el.lastChild);
      }

      for (let j = 0; j < letters.length; j++) {
        const span = letters[j];
        if (j < target.length) {
          const ch = target.charAt(j);
          if (span.textContent !== ch) span.textContent = ch;
          if (j < got.length) {
            span.className = got.charAt(j) === ch ? 'letter correct' : 'letter incorrect';
          } else {
            span.className = 'letter';
          }
        } else {
          /* Overtyped characters, appended past the end of the word. */
          span.textContent = got.charAt(j);
          span.className = 'letter extra';
        }
      }

      /* A word left behind with mistakes keeps a red underline. */
      const abandoned = index < engine.state.wordIndex;
      el.classList.toggle('error', abandoned && got !== target);
    }

    /* Keep the active line in the middle of the three visible lines. */
    function updateScroll(caretY) {
      if (lineHeight <= 0 || engine.isSingle()) return;
      const line = Math.round(caretY / lineHeight);
      const target = Math.max(0, line - 1);
      if (target === scrolledLines) return;
      scrolledLines = target;
      applyScroll();
    }

    /* The caret's target: the left edge of the next character to type, or
       the right edge of the last one when the word is full. */
    function measureCaret() {
      const s = engine.state;
      const wordEl = wordEls[s.wordIndex];
      if (!wordEl) return null;

      const letters = wordEl.children;
      const typedLen = (s.typed[s.wordIndex] || '').length;

      if (typedLen < letters.length) {
        const r = rectWithin(letters[typedLen]);
        return { x: r.x, y: r.y, h: r.h };
      }
      if (letters.length > 0) {
        const r = rectWithin(letters[letters.length - 1]);
        return { x: r.x + r.w, y: r.y, h: r.h };
      }
      const r = rectWithin(wordEl);
      return { x: r.x, y: r.y, h: r.h };
    }

    function paintCaret() {
      dom.caret.style.height = caretAt.h + 'px';
      /* translate3d keeps this on the compositor: moving the caret never
         costs a layout or a paint. */
      dom.caret.style.transform =
        'translate3d(' + caretAt.x + 'px,' + caretAt.y + 'px,0)';
    }

    function snapCaret(to) {
      caretAt.x = to.x;
      caretAt.y = to.y;
      caretAt.h = to.h;
      paintCaret();
    }

    function caretFrame(now) {
      const t = now / 1000;
      const dt = caretLast ? Math.min(CARET_MAX_DT, t - caretLast) : 1 / 60;
      caretLast = t;

      caretAt.x = approach(caretAt.x, caretTo.x, dt, CARET_TAU);
      caretAt.y = caretTo.y;
      caretAt.h = caretTo.h;
      paintCaret();

      if (Math.abs(caretTo.x - caretAt.x) < CARET_DONE_PX) {
        /* Land exactly on the target rather than asymptotically near it,
           then stop burning frames until the next keystroke. */
        snapCaret(caretTo);
        caretRaf = null;
        return;
      }
      caretRaf = requestAnimationFrame(caretFrame);
    }

    function startCaretLoop() {
      if (caretRaf !== null) return;
      caretLast = 0;
      caretRaf = requestAnimationFrame(caretFrame);
    }

    function updateCaret() {
      const to = measureCaret();
      if (!to) return;

      const jumped = shouldSnap(to.x - caretAt.x, to.y - caretAt.y);
      caretTo.x = to.x;
      caretTo.y = to.y;
      caretTo.h = to.h;

      /* The scroll decision is made on the target, not on the smoothed
         position, so a line change is never delayed by the easing. */
      updateScroll(to.y);

      if (!caretPlaced || jumped || reduceMotion.matches) {
        caretPlaced = true;
        if (caretRaf !== null) { cancelAnimationFrame(caretRaf); caretRaf = null; }
        snapCaret(to);
        return;
      }

      startCaretLoop();
    }

    /* Stop the blink while keys are actually landing. */
    function pokeCaret() {
      dom.caret.classList.add('typing');
      if (caretTimer) clearTimeout(caretTimer);
      caretTimer = setTimeout(() => dom.caret.classList.remove('typing'), CARET_IDLE_MS);
    }

    function setFocused(focused) {
      dom.area.classList.toggle('blurred', !focused);
    }

    function onResize() {
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        measure();
        updateCaret();
      });
    }

    engine.on('rebuild', rebuild);
    engine.on('append', (payload) => append(payload.words));
    engine.on('paint', (payload) => {
      const list = payload.indexes;
      for (let i = 0; i < list.length; i++) paintWord(list[i]);
      if (engine.isSingle()) showOnly(engine.state.wordIndex);
      pokeCaret();
      updateCaret();
    });

    window.addEventListener('resize', onResize);

    return { rebuild, paintWord, updateCaret, measure, setFocused };
  }

  TT.createRenderer = createRenderer;
  /* Exported for tests. */
  TT.caretMath = { approach, shouldSnap, CARET_TAU, CARET_SNAP_PX };
})(window.TT);
