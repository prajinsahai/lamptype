/* =================================================================
   main.js - wiring.

   Grabs the DOM, builds the engine / renderer / ui, and owns keyboard
   and focus handling. Settings live here and reach the ui through
   hooks so there is exactly one copy of the truth.
   ================================================================= */

window.TT = window.TT || {};

(function (TT) {
  'use strict';

  /* Seconds below which a completed test is not worth recording. */
  const MIN_DURATION = 1;

  /* How long the results screen refuses keyboard restarts, so that
     carrying on typing cannot skip past it before it has been read. */
  const RESULTS_GUARD_MS = 2000;

  function boot() {
    const $ = (id) => document.getElementById(id);

    const dom = {
      area: $('typing-area'),
      words: $('words'),
      caret: $('caret'),
      input: $('hidden-input'),

      modeBar: $('mode-bar'),
      modeValues: $('mode-values'),
      liveBar: $('live-bar'),
      liveCounter: $('live-counter'),
      counterLabel: $('counter-label'),
      liveWpm: $('live-wpm'),

      announcer: $('announcer'),
      viewTest: $('view-test'),
      viewResults: $('view-results'),
      resWpm: $('res-wpm'),
      resAcc: $('res-acc'),
      resRaw: $('res-raw'),
      resCons: $('res-cons'),
      resTime: $('res-time'),
      resType: $('res-type'),
      resChars: $('res-chars'),
      resPb: $('res-pb'),
      resNote: $('res-note'),
      chart: $('res-chart'),

      historyModal: $('history-modal'),
      pbGrid: $('pb-grid'),
      historyBody: $('history-body'),

      themeSelect: $('theme-select'),
      btnRestart: $('btn-restart'),
      btnNext: $('btn-next'),
      race: $('race'),
      raceYou: $('race-you'),
      raceAi: $('race-ai'),
      raceYouWpm: $('race-you-wpm'),
      raceAiWpm: $('race-ai-wpm'),
      raceResult: $('race-result'),
      raceOutcome: $('race-outcome'),
      raceDetail: $('race-detail'),
      btnRace: $('btn-race'),

      btnHistory: $('btn-history'),
      btnDayNight: $('btn-daynight'),
      petalCanvas: $('petal-canvas'),
      lampCanvas: $('lamp-canvas'),
      btnClearHistory: $('btn-clear-history')
    };

    let settings = TT.storage.loadSettings();

    const engine = TT.createEngine();
    const renderer = TT.createRenderer(dom, engine);
    const petals = TT.createPetals(dom.petalCanvas);
    const lamp = TT.createLamp(dom.lampCanvas);
    const ui = TT.createUI(dom, engine, { getSettings, setSettings });

    function getSettings() {
      return settings;
    }

    /* Settings hold both time and word lengths; the engine only ever
       sees the one that applies to the active mode. */
    function currentConfig() {
      return {
        mode: settings.mode,
        modeValue: settings[TT.storage.settingFor(settings.mode)],
        punctuation: settings.punctuation,
        numbers: settings.numbers
      };
    }

    function setSettings(patch) {
      settings = Object.assign({}, settings, patch);
      /* There is nothing to race toward in time mode. */
      if (settings.mode !== 'words') raceMode = false;
      TT.storage.saveSettings(settings);
      ui.renderModeBar();
      restart();
    }

    /* Theme is the one setting that does not invalidate the test. */
    function setTheme(name) {
      settings = Object.assign({}, settings, { theme: ui.applyTheme(name) });
      TT.storage.saveSettings(settings);
      syncBackdrop();
    }

    function setColorMode(mode) {
      settings = Object.assign({}, settings, { colorMode: ui.applyColorMode(mode) });
      TT.storage.saveSettings(settings);
      petals.refreshPalette();
      lamp.refreshPalette();
    }

    /* Each backdrop belongs to exactly one theme and runs nowhere else,
       so at most one canvas is ever drawing. */
    function syncBackdrop() {
      const wanted = settings.theme === 'lamp' ? lamp
        : settings.theme === 'sakura' ? petals
        : null;

      [lamp, petals].forEach((backdrop) => {
        if (backdrop === wanted) {
          backdrop.start();
          backdrop.refreshPalette();
        } else {
          backdrop.stop();
        }
      });
    }

    /* ---------------------------- the cursor ----------------------------
       Hidden on the first keystroke of a run and restored by the smallest
       mouse movement, the way a video player does it. Nothing else brings
       it back, so it can never be lost: moving the mouse is exactly the
       gesture that means you want to point at something. */

    let cursorHidden = false;

    function hideCursor() {
      if (cursorHidden) return;
      cursorHidden = true;
      document.body.classList.add('typing-cursor-hidden');
    }

    function showCursor() {
      if (!cursorHidden) return;
      cursorHidden = false;
      document.body.classList.remove('typing-cursor-hidden');
    }

    /* Passive: this fires on every mouse move and must never hold up a
       frame. */
    document.addEventListener('mousemove', showCursor, { passive: true });
    document.addEventListener('mousedown', showCursor, { passive: true });

    function focusInput() {
      try {
        dom.input.focus({ preventScroll: true });
      } catch (err) {
        dom.input.focus();
      }
    }

    /* --------------------------- results guard ---------------------------
       A test can end mid-keystroke, especially in time mode. For a moment
       afterwards the results screen ignores every keyboard route back to a
       new test, so momentum typing cannot blow it away unread. */

    const resultsGuard = TT.createGuard(RESULTS_GUARD_MS);
    let guardTimer = null;

    function armResultsGuard() {
      resultsGuard.arm();
      dom.viewResults.classList.add('guarded');

      /* Focus is withheld until the guard lifts. A focused button is
         activated by the space bar, so taking focus immediately is itself
         the fastest way to lose the results. */
      if (guardTimer) clearTimeout(guardTimer);
      guardTimer = setTimeout(() => {
        guardTimer = null;
        dom.viewResults.classList.remove('guarded');
        if (!dom.viewResults.hidden) dom.btnNext.focus();
      }, RESULTS_GUARD_MS);
    }

    function clearResultsGuard() {
      resultsGuard.clear();
      if (guardTimer) {
        clearTimeout(guardTimer);
        guardTimer = null;
      }
      dom.viewResults.classList.remove('guarded');
    }

    /* Keyboard routes to a new test go through here and can be refused.
       A deliberate pointer action - a button, a mode change - calls
       restart() directly and always goes through. */
    function requestRestart() {
      if (resultsGuard.active()) return;
      restart();
    }

    /* ------------------------------- race -------------------------------
       raceMode is sticky: once you are racing, every restart lines up a
       fresh opponent, so you can go again with tab. The `race` object is
       the one currently running. */

    let raceMode = false;
    let race = null;
    let raceRaf = null;

    function stopRaceLoop() {
      if (raceRaf !== null) cancelAnimationFrame(raceRaf);
      raceRaf = null;
    }

    function setupRace() {
      stopRaceLoop();
      race = null;

      if (!raceMode) {
        ui.setRaceVisible(false);
        return;
      }

      const wpm = TT.race.opponentWpm({
        average: TT.race.averageWpm(TT.storage.loadHistory()),
        racesCompleted: TT.storage.loadRaceCount()
      });

      race = {
        opponent: TT.race.createOpponent(wpm),
        total: TT.race.totalChars(engine.state.words),
        opponentWpm: wpm,
        aiFinished: false
      };

      ui.setRaceVisible(true);
      ui.setRaceProgress(0, 0);
      ui.setRaceSpeeds(0, wpm);
    }

    function raceFrame() {
      raceRaf = requestAnimationFrame(raceFrame);
      if (!race) return;

      /* Both racers read the same clock, so dropped frames cannot make
         the opponent fall behind. */
      const ai = race.opponent.positionAt(engine.elapsed());
      const you = TT.race.caretPosition(
        engine.state.words, engine.state.typed, engine.state.wordIndex
      );

      ui.setRaceProgress(you / race.total, ai / race.total);

      if (!race.aiFinished && ai >= race.total) {
        race.aiFinished = true;
        ui.markRaceFinished('ai');
      }
    }

    /* The opponent starts on your first keystroke, not on the button:
       otherwise it is already moving while you are still reading, and
       the race is lost to reaction time rather than typing. */
    function startRaceLoop() {
      if (raceRaf !== null || !race) return;
      raceRaf = requestAnimationFrame(raceFrame);
    }

    function toggleRace() {
      raceMode = !raceMode;

      /* A race needs a finish line, so it always runs over a fixed number
         of words. Switch the mode bar to match rather than let it show
         something other than what is running. */
      if (raceMode && settings.mode !== 'words') {
        settings = Object.assign({}, settings, { mode: 'words' });
        TT.storage.saveSettings(settings);
        ui.renderModeBar();
      }

      restart();
    }

    function restart() {
      clearResultsGuard();
      /* The view must be visible before the engine rebuilds: the renderer
         measures row pitch from the DOM, and a display:none container
         measures as zero. */
      ui.showTest();
      engine.reset(currentConfig());
      ui.setTyping(false);
      ui.updateLive();
      setupRace();
      focusInput();
    }

    /* ------------------------------ engine ------------------------------ */

    engine.on('tick', () => {
      ui.updateLive();
      if (race) ui.setRaceSpeeds(engine.liveStats().wpm, race.opponentWpm);
    });

    engine.on('start', () => {
      ui.setTyping(true);
      startRaceLoop();
    });
    engine.on('key', (e) => {
      petals.onKeystroke(!e.correct);
      lamp.onKeystroke(!e.correct);
      hideCursor();
    });

    engine.on('finish', (result) => {
      ui.setTyping(false);
      /* The run is over and there are buttons to click. */
      showCursor();

      const typedAnything =
        result.chars.correct + result.chars.incorrect + result.chars.extra > 0;

      /* Below a second the wpm figure is arithmetic noise - a handful of
         characters divided by a sliver of time. Such a run is shown but
         never recorded, so it cannot poison the personal bests. */
      const recorded = typedAnything && result.duration >= MIN_DURATION;

      const previousBest = TT.storage.bestFor(
        TT.storage.loadHistory(),
        TT.storage.modeKey(result)
      );
      const isPersonalBest = recorded && (!previousBest || result.wpm > previousBest.wpm);

      /* You win by finishing before the opponent reaches the end.
         Read the opponent off the clock rather than trusting the flag the
         render loop sets: if frames stalled, that flag may never have been
         raised even though the opponent crossed the line. */
      let raceOutcome = null;
      if (race) {
        stopRaceLoop();
        ui.markRaceFinished('you');
        const opponentAt = race.opponent.positionAt(engine.elapsed());
        raceOutcome = { won: opponentAt < race.total, opponentWpm: race.opponentWpm };

        /* Only a real race counts toward calibration, otherwise a string
           of instant finishes would inflate the difficulty ramp. */
        if (recorded) TT.storage.bumpRaceCount();
        race = null;
      }

      if (recorded) {
        /* Samples are only needed for the screen in front of us; keeping
           them out of storage keeps the history entry small. */
        const stored = Object.assign({}, result);
        delete stored.samples;
        if (raceOutcome) {
          stored.race = true;
          stored.opponentWpm = raceOutcome.opponentWpm;
          stored.won = raceOutcome.won;
        }
        TT.storage.addResult(stored);
      }

      ui.showResults(result, isPersonalBest, recorded, raceOutcome);
      /* Drop focus so nothing can be activated by a stray key, then hold
         the screen still for a beat. */
      dom.input.blur();
      armResultsGuard();
    });

    /* ------------------------------ input ------------------------------ */

    dom.input.addEventListener('focus', () => renderer.setFocused(true));
    dom.input.addEventListener('blur', () => renderer.setFocused(false));

    dom.area.addEventListener('mousedown', (event) => {
      event.preventDefault(); // keep focus, suppress text selection
      focusInput();
    });

    dom.input.addEventListener('keydown', (event) => {
      const key = event.key;

      /* Shift+Tab is the way out of the typing area.
         Tab alone restarts the test, which means the typing area would
         otherwise swallow the only key a keyboard user has for moving on -
         a WCAG 2.1.2 keyboard trap. Letting the shifted form through to the
         browser gives focus somewhere to go, and the hint under the words
         says so, which is what 2.1.2 asks for when the exit is not plain
         Tab. */
      if (key === 'Tab' && event.shiftKey) return;

      if (key === 'Tab' || key === 'Escape') {
        event.preventDefault();
        requestRestart();
        return;
      }

      if (key === 'Backspace') {
        event.preventDefault();
        engine.backspace(event.ctrlKey || event.altKey || event.metaKey);
        return;
      }

      if (key === 'Enter') {
        event.preventDefault();
        return;
      }

      /* Leave real browser shortcuts alone. */
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      if (key === ' ') {
        event.preventDefault();
        engine.typeSpace();
        return;
      }

      if (key.length === 1) {
        event.preventDefault();
        engine.typeChar(key);
      }
      /* Anything else - including the "Unidentified" that some soft
         keyboards send - falls through to the input event below. */
    });

    dom.input.addEventListener('input', (event) => {
      const value = dom.input.value;
      dom.input.value = '';

      if (event.inputType === 'deleteContentBackward') {
        engine.backspace(false);
        return;
      }

      for (const ch of value) {
        if (ch === ' ') engine.typeSpace();
        else engine.typeChar(ch);
      }
    });

    /* Focus recovery: if the caret is not armed, the next printable key
       should both restore focus and land in the test. */
    document.addEventListener('keydown', (event) => {
      if (ui.isHistoryOpen()) {
        if (event.key === 'Escape') {
          event.preventDefault();
          ui.closeHistory();
          focusInput();
        }
        return;
      }

      if (!dom.viewResults.hidden) {
        if (event.key === 'Tab' && event.shiftKey) return;   // let focus leave
        if (event.key === 'Tab' || event.key === 'Escape') {
          event.preventDefault();
          requestRestart();
        }
        return;
      }

      if (document.activeElement === dom.input) return;

      /* Focus is deliberately on a control - let Tab navigate normally. */
      const tag = event.target && event.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;

      if (event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        requestRestart();
        return;
      }

      if (event.key.length !== 1) return;

      event.preventDefault();
      focusInput();
      if (event.key === ' ') engine.typeSpace();
      else engine.typeChar(event.key);
    });

    /* ----------------------------- controls ----------------------------- */

    dom.btnRestart.addEventListener('click', restart);
    dom.btnNext.addEventListener('click', restart);

    dom.btnRace.addEventListener('click', toggleRace);

    dom.btnHistory.addEventListener('click', () => ui.openHistory());

    dom.btnClearHistory.addEventListener('click', () => {
      TT.storage.clearHistory();
      ui.renderHistory();
    });

    dom.themeSelect.addEventListener('change', () => setTheme(dom.themeSelect.value));

    dom.btnDayNight.addEventListener('click', () => {
      const modes = TT.config.COLOR_MODES;
      const next = modes[(modes.indexOf(settings.colorMode) + 1) % modes.length];
      setColorMode(next);
    });

    /* ------------------------------- boot ------------------------------- */

    ui.applyTheme(settings.theme);
    ui.applyColorMode(settings.colorMode);
    syncBackdrop();
    ui.renderModeBar();
    renderer.setFocused(false);
    restart();

    /* Font swaps change the row pitch, so re-measure once they settle. */
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        renderer.measure();
        renderer.updateCaret();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window.TT);
