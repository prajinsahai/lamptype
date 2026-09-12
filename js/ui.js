/* =================================================================
   ui.js - everything the user reads: mode bar, live readout, the
   results screen and the history modal.

   Holds no state of its own beyond the last result (needed so the
   chart can be redrawn on resize or theme change). Settings live in
   main.js and reach here through the getSettings/setSettings hooks.
   ================================================================= */

window.TT = window.TT || {};

(function (TT) {
  'use strict';

  const HISTORY_ROWS = 20;

  function formatDuration(seconds) {
    if (seconds < 60) return (Math.round(seconds * 10) / 10) + 's';
    const mins = Math.floor(seconds / 60);
    return mins + 'm ' + Math.round(seconds - mins * 60) + 's';
  }

  function formatDate(ts) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '-';
    const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return day + ' ' + time;
  }

  /**
   * A one-shot window during which an action is refused. Used to hold the
   * results screen still for a moment after a test ends, so that carrying
   * on typing cannot skip past it unread.
   *
   * The clock is injectable so the behaviour can be tested without waiting.
   */
  function createGuard(durationMs, clock) {
    const now = clock || (() => performance.now());
    let until = 0;

    return {
      arm() { until = now() + durationMs; },
      clear() { until = 0; },
      active() { return now() < until; },
      remaining() { return Math.max(0, until - now()); }
    };
  }

  const asWpm = (n) => String(Math.round(n));
  const asPct = (n) => Math.round(n) + '%';

  function createUI(dom, engine, hooks) {
    let lastResult = null;
    /* Sakura drops the running wpm readout entirely. */
    let liveWpmVisible = true;

    /* ---------------------------- mode bar ---------------------------- */

    function renderModeBar() {
      const s = hooks.getSettings();

      dom.modeBar.querySelectorAll('[data-toggle]').forEach((btn) => {
        const on = !!s[btn.dataset.toggle];
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
      });

      dom.modeBar.querySelectorAll('[data-mode]').forEach((btn) => {
        const on = s.mode === btn.dataset.mode;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
      });

      const values = TT.storage.valuesFor(s.mode);
      const current = s[TT.storage.settingFor(s.mode)];

      /* Reused rather than rebuilt. A button born with .active already on
         it has no state to animate from, so wiping the row meant the rule
         never moved and every length change read as a cut. Recreating the
         row also drops keyboard focus to <body> if one of them had it. */
      const btns = Array.from(dom.modeValues.querySelectorAll('.mode-btn'));
      while (btns.length > values.length) dom.modeValues.removeChild(btns.pop());

      values.forEach((v, i) => {
        let btn = btns[i];
        if (!btn) {
          btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'mode-btn';
          dom.modeValues.appendChild(btn);
        }
        const on = v === current;
        btn.dataset.value = String(v);
        btn.textContent = String(v);
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
      });

      positionSliders();
    }

    /* One rule per single-select group, slid to the active choice. The
       per-button rules in style.css stay for the include toggles, where
       two can be lit at once and there is nothing to slide between. */
    function positionSliders() {
      dom.modeBar.querySelectorAll('[data-slider]').forEach((group) => {
        /* No layout while the results screen is up: offsetLeft reads 0
           and would collapse the rule onto the left edge. Leave it where
           it is - showTest puts it back once the bar is on screen. */
        if (!group.offsetParent) return;

        let bar = group.querySelector('.mode-underline');
        const fresh = !bar;
        if (fresh) {
          bar = document.createElement('span');
          bar.className = 'mode-underline';
          bar.style.transition = 'none';
          /* First child, so appending a button never lands after it. */
          group.insertBefore(bar, group.firstChild);
        }

        const active = group.querySelector('.mode-btn.active');
        bar.style.opacity = active ? '1' : '0';
        if (active) {
          bar.style.transform = 'translateX(' + active.offsetLeft + 'px) ' +
                                'scaleX(' + active.offsetWidth + ')';
        }

        if (fresh) {
          /* Flush the first position before the transition exists, or the
             rule slides in from the left edge on load. */
          void bar.offsetWidth;
          bar.style.transition = '';
        }
      });
    }

    dom.modeBar.addEventListener('click', (event) => {
      const btn = event.target.closest('button');
      if (!btn) return;

      if (btn.dataset.toggle) {
        const key = btn.dataset.toggle;
        const patch = {};
        patch[key] = !hooks.getSettings()[key];
        hooks.setSettings(patch);
      } else if (btn.dataset.mode) {
        hooks.setSettings({ mode: btn.dataset.mode });
      } else if (btn.dataset.value) {
        /* Each mode remembers its own length, so switching modes never
           clobbers the setting of the one you left. */
        const patch = {};
        patch[TT.storage.settingFor(hooks.getSettings().mode)] = Number(btn.dataset.value);
        hooks.setSettings(patch);
      }
    });

    /* --------------------------- live readout --------------------------- */

    function updateLive() {
      const s = hooks.getSettings();

      /* The number means different things in different modes, so the
         label beside it has to say which. */
      if (TT.storage.isTimed(s.mode)) {
        dom.counterLabel.textContent = 'left';
        dom.liveCounter.textContent = String(Math.ceil(engine.remaining()));
      } else {
        dom.counterLabel.textContent = 'words';
        dom.liveCounter.textContent =
          engine.state.wordIndex + '/' + engine.state.words.length;
      }

      if (liveWpmVisible) {
        /* The label beside it already says "speed" - the unit would only
           be repeating it, and it breaks the tabular column. */
        dom.liveWpm.textContent = engine.isRunning()
          ? asWpm(engine.liveStats().wpm)
          : '';
      }
    }

    /* The mode bar fades out once typing starts so it never competes
       with the words for attention. */
    function setTyping(active) {
      dom.modeBar.classList.toggle('dim', active);
      /* Sakura fades the stats row while typing and restores it at the
         end; the other themes have no rule for this class. */
      dom.liveBar.classList.toggle('typing', active);
    }

    /* ------------------------------ theme ------------------------------ */

    function applyTheme(name) {
      const theme = TT.config.THEMES.indexOf(name) === -1
        ? TT.storage.DEFAULTS.theme
        : name;

      document.documentElement.setAttribute('data-theme', theme);
      if (dom.themeSelect.value !== theme) dom.themeSelect.value = theme;
      syncThemeColor();
      liveWpmVisible = theme !== 'sakura';
      if (!liveWpmVisible) dom.liveWpm.textContent = '';

      /* The chart samples CSS variables at draw time, so it has to be
         repainted whenever the palette changes. */
      if (lastResult && !dom.viewResults.hidden) redrawChart();
      /* Sakura sets the labels in a different face and tracking, so the
         buttons move and the rule has to follow them. */
      positionSliders();
      return theme;
    }

    /* Light / dark within a theme. 'auto' removes the attribute so the
       prefers-color-scheme rules take over. */
    function applyColorMode(mode) {
      const valid = TT.config.COLOR_MODES.indexOf(mode) === -1 ? 'auto' : mode;
      const root = document.documentElement;

      if (valid === 'auto') root.removeAttribute('data-mode');
      else root.setAttribute('data-mode', valid);
      syncThemeColor();

      dom.btnDayNight.textContent = valid;
      dom.btnDayNight.setAttribute('aria-label', 'colour mode: ' + valid);

      if (lastResult && !dom.viewResults.hidden) redrawChart();
      return valid;
    }

    /* The address bar and task switcher take their colour from this, so it
       has to follow the palette rather than sit on the default. */
    function syncThemeColor() {
      const tag = document.querySelector('meta[name="theme-color"]');
      if (!tag) return;
      const bg = getComputedStyle(document.documentElement)
        .getPropertyValue('--bg').trim();
      if (bg) tag.setAttribute('content', bg);
    }

    /* Spoken to screen readers when a test ends. The results screen is a
       silent DOM swap otherwise, so without this a blind typist finishes a
       test and is told nothing at all. */
    function announceResult(result, isPersonalBest, recorded, raceOutcome) {
      if (!dom.announcer) return;

      const parts = [
        'Test complete.',
        asWpm(result.wpm) + ' words per minute,',
        asPct(result.accuracy) + ' accuracy,',
        formatDuration(result.duration) + '.'
      ];
      if (raceOutcome) parts.push(raceOutcome.won ? 'You won the race.' : 'The AI won the race.');
      if (isPersonalBest) parts.push('New personal best.');
      if (recorded === false) parts.push('Too short to record.');
      parts.push('Press tab for a new test.');

      /* Clearing first guarantees the region is seen to change even when
         two runs produce identical numbers. */
      dom.announcer.textContent = '';
      const message = parts.join(' ');
      requestAnimationFrame(() => { dom.announcer.textContent = message; });
    }

    /* ------------------------- results reveal ------------------------- */

    /* Handles for the animations currently running on the results
       screen. Everything is cancellable so a second test finishing (or
       a resize part-way through) can never leave two runs fighting over
       the same element - cancelling snaps straight to the final value. */
    let stopReveals = [];
    let stopChart = null;
    let chartRaf = 0;

    function cancelReveals() {
      stopReveals.forEach((stop) => stop());
      stopReveals = [];
      if (chartRaf) { cancelAnimationFrame(chartRaf); chartRaf = 0; }
      if (stopChart) { stopChart(); stopChart = null; }
    }

    /* A short stagger across the row reads as one gesture rather than
       five separate ones. */
    function revealStat(el, text, order) {
      stopReveals.push(TT.reveal.scrambleText(el, text, { delay: (order || 0) * 45 }));
    }

    function redrawChart() {
      if (!lastResult) return;
      if (chartRaf) { cancelAnimationFrame(chartRaf); chartRaf = 0; }
      if (stopChart) { stopChart(); stopChart = null; }
      TT.chart.draw(dom.chart, lastResult.samples);
    }

    /* ------------------------------- race ------------------------------- */

    const clamp01 = (n) => Math.min(1, Math.max(0, n || 0));

    function setRaceVisible(visible) {
      dom.race.hidden = !visible;
      dom.btnRace.classList.toggle('racing', visible);
      dom.btnRace.textContent = visible ? 'racing' : 'start race';

      if (!visible) {
        setRaceProgress(0, 0);
        dom.raceYouWpm.textContent = '';
        dom.raceAiWpm.textContent = '';
        dom.race.querySelectorAll('.race-lane').forEach((l) => l.classList.remove('done'));
      }
    }

    function setRaceProgress(you, ai) {
      dom.raceYou.style.width = (clamp01(you) * 100).toFixed(2) + '%';
      dom.raceAi.style.width = (clamp01(ai) * 100).toFixed(2) + '%';
    }

    function setRaceSpeeds(yourWpm, opponentWpm) {
      dom.raceYouWpm.textContent = yourWpm > 0 ? asWpm(yourWpm) : '';
      dom.raceAiWpm.textContent = opponentWpm > 0 ? asWpm(opponentWpm) : '';
    }

    /* Marks whichever lane has reached the end. */
    function markRaceFinished(who) {
      const fill = who === 'ai' ? dom.raceAi : dom.raceYou;
      const lane = fill.closest('.race-lane');
      if (lane) lane.classList.add('done');
    }

    /* ----------------------------- results ----------------------------- */

    /* Crossfades the two views and carries the height change with them.
       Only the entering view was ever animated: the outgoing one went to
       display:none on the spot, which no CSS transition can reach across,
       so the page collapsed and the new panel lifted into a gap.

       The callback runs asynchronously, after the outgoing view has been
       captured - so every mutation has to be inside it, including the
       chart's requestAnimationFrame, which otherwise measures a canvas
       that is still hidden and gets a width of zero. */
    function swapViews(mutate) {
      if (TT.reveal.reducedMotion() || !document.startViewTransition) {
        mutate();
        return;
      }
      document.startViewTransition(mutate);
    }

    function showResults(result, isPersonalBest, recorded, raceOutcome) {
      lastResult = result;
      const c = result.chars;

      /* Synchronous: a pending reveal must not fire into the swap. */
      cancelReveals();

      swapViews(() => {
        /* The numbers shuffle through random digits and settle into the
           real value; the mode label is words, so it just appears. */
        revealStat(dom.resWpm, asWpm(result.wpm), 0);
        revealStat(dom.resAcc, asPct(result.accuracy), 1);
        revealStat(dom.resRaw, asWpm(result.raw), 0);
        revealStat(dom.resChars, [c.correct, c.incorrect, c.extra, c.missed].join('/'), 1);
        revealStat(dom.resCons, asPct(result.consistency), 2);
        revealStat(dom.resTime, formatDuration(result.duration), 3);
        dom.resType.textContent = TT.storage.modeLabel(result);
        dom.resPb.hidden = !isPersonalBest;
        dom.resNote.hidden = recorded !== false;

        if (raceOutcome) {
          dom.raceResult.hidden = false;
          dom.raceResult.classList.toggle('lost', !raceOutcome.won);
          dom.raceOutcome.textContent = raceOutcome.won ? 'you won' : 'the ai won';
          dom.raceDetail.textContent =
            'opponent ' + asWpm(raceOutcome.opponentWpm) + ' wpm';
        } else {
          dom.raceResult.hidden = true;
        }

        dom.viewTest.hidden = true;
        dom.viewResults.hidden = false;
        announceResult(result, isPersonalBest, recorded, raceOutcome);

        /* Wait for layout: the canvas has no width until it is visible. */
        chartRaf = requestAnimationFrame(() => {
          chartRaf = 0;
          stopChart = TT.chart.animate(dom.chart, result.samples);
        });
      });
    }

    function showTest() {
      cancelReveals();
      swapViews(() => {
        if (dom.announcer) dom.announcer.textContent = '';
        dom.viewResults.hidden = true;
        dom.viewTest.hidden = false;
        /* The bar had no layout while the results were up, so the rule
           was left behind wherever it last sat. */
        positionSliders();
      });
    }

    /* ----------------------------- history ----------------------------- */

    function pbCard(entry) {
      const card = document.createElement('div');
      card.className = 'pb-card';

      const mode = document.createElement('div');
      mode.className = 'pb-mode';
      mode.textContent = TT.storage.modeLabel(entry);

      const wpm = document.createElement('div');
      wpm.className = 'pb-wpm';
      wpm.textContent = asWpm(entry.wpm);

      const acc = document.createElement('div');
      acc.className = 'pb-acc';
      acc.textContent = asPct(entry.accuracy) + ' acc';

      card.append(mode, wpm, acc);
      return card;
    }

    function historyRow(entry) {
      const tr = document.createElement('tr');
      const cells = [
        asWpm(entry.wpm),
        asWpm(entry.raw),
        asPct(entry.accuracy),
        TT.storage.modeLabel(entry),
        formatDate(entry.ts)
      ];
      cells.forEach((text) => {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });
      return tr;
    }

    function note(text) {
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = text;
      return p;
    }

    function renderHistory() {
      const history = TT.storage.loadHistory();
      const bests = TT.storage.personalBests(history);

      dom.pbGrid.textContent = '';
      if (bests.length === 0) {
        dom.pbGrid.appendChild(note('no completed tests yet'));
      } else {
        bests.forEach((entry) => dom.pbGrid.appendChild(pbCard(entry)));
      }

      /* With nothing to show, the table goes away rather than standing
         there as five column headings over an apology. A header row with
         no data under it is also a broken table to a screen reader, not
         an empty one. */
      const wrap = dom.historyBody.closest('.table-wrap');
      dom.historyBody.textContent = '';
      if (history.length === 0) {
        if (wrap) {
          wrap.hidden = true;
          if (!wrap.nextElementSibling ||
              !wrap.nextElementSibling.classList.contains('empty-note')) {
            wrap.insertAdjacentElement('afterend',
              note('nothing here yet - finish a test to fill this in'));
          }
        }
      } else {
        if (wrap) {
          wrap.hidden = false;
          const stale = wrap.nextElementSibling;
          if (stale && stale.classList.contains('empty-note')) stale.remove();
        }
        history.slice(0, HISTORY_ROWS).forEach((entry) => {
          dom.historyBody.appendChild(historyRow(entry));
        });
      }
    }

    /* showModal() is what makes this a modal rather than a div that looks
       like one: it moves focus in, holds Tab inside the card, renders the
       page behind it inert, closes on Escape and hands focus back. */
    function openHistory() {
      if (dom.historyModal.open) return;
      renderHistory();
      dom.historyModal.showModal();
    }

    function closeHistory() {
      if (dom.historyModal.open) dom.historyModal.close();
    }

    function isHistoryOpen() {
      return dom.historyModal.open === true;
    }

    dom.historyModal.addEventListener('click', (event) => {
      /* The dialog fills the viewport, so a click that lands on the
         element itself rather than on the card is a backdrop click.
         ::backdrop is painted, not hit-tested, so there is no node. */
      if (event.target === dom.historyModal) closeHistory();
      else if (event.target.closest('[data-close]')) closeHistory();
    });

    window.addEventListener('resize', () => {
      if (!dom.viewResults.hidden) redrawChart();
      /* A reflow moves the buttons out from under the rule. */
      positionSliders();
    });

    return {
      renderModeBar,
      updateLive,
      setRaceVisible,
      setRaceProgress,
      setRaceSpeeds,
      markRaceFinished,
      setTyping,
      applyTheme,
      applyColorMode,
      showResults,
      showTest,
      renderHistory,
      openHistory,
      closeHistory,
      isHistoryOpen,
      redrawChart
    };
  }

  TT.createUI = createUI;
  TT.createGuard = createGuard;
  TT.format = { formatDuration, formatDate, asWpm, asPct };
})(window.TT);
