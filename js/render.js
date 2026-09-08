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

  function createRenderer(dom, engine) {
    const wordEls = [];
    let lineHeight = 0;
    let scrolledLines = 0;
    let caretTimer = null;
    let resizeFrame = null;
    let activeEl = null;   // the shown word in '1 word' mode

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

    /* Distance from a letter to the words container. Walking the
       offsetParent chain rather than reading one offsetLeft keeps the
       caret right no matter what is positioned or transformed between
       them. */
    function offsetWithin(el, ancestor) {
      let x = 0;
      let y = 0;
      let node = el;
      while (node && node !== ancestor) {
        x += node.offsetLeft;
        y += node.offsetTop;
        node = node.offsetParent;
      }
      return { x, y };
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

    function updateCaret() {
      const s = engine.state;
      const wordEl = wordEls[s.wordIndex];
      if (!wordEl) return;

      const letters = wordEl.children;
      const typedLen = (s.typed[s.wordIndex] || '').length;
      let x;
      let y;
      let h;

      if (typedLen < letters.length) {
        const span = letters[typedLen];
        const at = offsetWithin(span, dom.words);
        x = at.x;
        y = at.y;
        h = span.offsetHeight;
      } else if (letters.length > 0) {
        const span = letters[letters.length - 1];
        const at = offsetWithin(span, dom.words);
        x = at.x + span.offsetWidth;
        y = at.y;
        h = span.offsetHeight;
      } else {
        const at = offsetWithin(wordEl, dom.words);
        x = at.x;
        y = at.y;
        h = wordEl.offsetHeight;
      }

      dom.caret.style.height = h + 'px';
      dom.caret.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      updateScroll(y);
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
})(window.TT);
