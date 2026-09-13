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

  /* How long "clear history" stays armed before it forgets it was asked.
     Long enough to move the mouse back, short enough that an armed
     button is never still waiting when you return to the panel. */
  const CLEAR_CONFIRM_MS = 4000;

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
      raceAiLabel: $('race-ai-label'),
      raceYouWpm: $('race-you-wpm'),
      raceAiWpm: $('race-ai-wpm'),
      raceResult: $('race-result'),
      raceOutcome: $('race-outcome'),
      raceDetail: $('race-detail'),
      btnRace: $('btn-race'),

      room: $('room'),
      roomNick: $('room-nick'),
      roomStatus: $('room-status'),
      btnRoom: $('btn-room'),
      btnRoomReady: $('btn-room-ready'),
      btnRoomLink: $('btn-room-link'),
      btnRoomLeave: $('btn-room-leave'),

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
        rivalFinished: false
      };

      ui.setRaceVisible(true);
      ui.setRaceOpponent('ai');
      ui.setRaceProgress(0, 0);
      ui.setRaceSpeeds(0, wpm);
    }

    /* True while a room race has been called but the gun has not gone.
       The passage is on screen to be read, and nothing may be typed into
       it yet: the clock starts for everybody at the same instant. */
    function beforeGun() {
      return !!(race && race.room && room && room.msUntilStart() > 0);
    }

    function raceFrame() {
      raceRaf = requestAnimationFrame(raceFrame);
      if (!race) return;

      const you = TT.race.caretPosition(
        engine.state.words, engine.state.typed, engine.state.wordIndex
      );

      let rival = 0;

      if (race.room) {
        const wait = room ? room.msUntilStart() : 0;
        if (wait > 0) {
          ui.setRoomStatus('starting in ' + Math.ceil(wait / 1000));
          return;
        }
        /* The first frame past the gun starts the test, so the run is
           measured from the same instant for everyone rather than from
           whenever each person got round to typing. */
        if (!engine.isRunning() && !engine.isFinished()) {
          ui.setRoomStatus('go');
          engine.begin();
        }

        room.reportPosition(you);

        /* One lane is shown against yours, and it is whoever is actually
           in front. Their position is read off the shared clock, which is
           the same discipline the AI opponent follows. */
        const lead = TT.netMath.leaderAt(room.peers(), room.toRaceSeconds(room.serverNow()));
        rival = lead.pos;
        race.rivalCps = lead.peer ? lead.peer.rate() : 0;
        ui.setRaceOpponent(lead.peer ? lead.peer.nick : 'nobody');
      } else {
        /* Both racers read the same clock, so dropped frames cannot make
           the opponent fall behind. */
        rival = race.opponent.positionAt(engine.elapsed());
      }

      ui.setRaceProgress(you / race.total, rival / race.total);

      if (!race.rivalFinished && rival >= race.total) {
        race.rivalFinished = true;
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

    /* `random` is the room's seeded generator, or null for solo play. It
       is passed on every rebuild rather than only when seeded, because
       the engine merges its config: a seed left behind would make every
       later solo test repeat the same passage. */
    function rebuild(random) {
      clearResultsGuard();
      /* The view must be visible before the engine rebuilds: the renderer
         measures row pitch from the DOM, and a display:none container
         measures as zero. */
      ui.showTest();
      engine.reset(Object.assign(currentConfig(), { random: random || null }));
      ui.setTyping(false);
      ui.updateLive();
    }

    function restart() {
      /* The room owns the passage once a race has been called: a local
         restart would put you on words nobody else is typing. */
      if (race && race.room) return;
      rebuild(null);
      setupRace();
      focusInput();
    }

    /* ------------------------------- room -------------------------------
       A room is a socket, a roster and a seed. What it feeds the race
       loop satisfies the shape js/race.js already returns, so the engine,
       the renderer and the stats never learn that it exists. */

    let room = null;

    function setRoomHash(id) {
      const url = window.location.pathname + window.location.search + (id ? '#r=' + id : '');
      try {
        window.history.replaceState(null, '', url);
      } catch (err) {
        /* Some browsers refuse replaceState on a file:// page. */
        window.location.hash = id ? 'r=' + id : '';
      }
    }

    function openRoom(id) {
      if (room) return;
      if (!TT.config.ROOM_URL) {
        ui.setRoomVisible(true);
        ui.setRoomStatus('no race server is configured for this site');
        return;
      }

      /* One opponent at a time: the AI has no seat in a room. */
      raceMode = false;
      setupRace();

      room = TT.createRoom({
        url: TT.config.ROOM_URL,
        id,
        nick: settings.nick,
        count: settings.wordValue,
        punctuation: settings.punctuation,
        numbers: settings.numbers
      });

      ui.setRoomVisible(true);
      ui.setRoomNickEditable(false);
      ui.setRoomStatus('connecting');

      room.on('open', () => ui.setRoomStatus('waiting for someone to join'));

      room.on('room', (state) => {
        /* Mid-race the line is the countdown, and afterwards it is the
           standings - which stay up until somebody presses ready and the
           roster becomes the useful thing to show again. */
        if (race && race.room) return;
        if (state.status === 'over' && !state.players.some((p) => p.ready)) return;
        if (state.players.length < 2) {
          ui.setRoomStatus('waiting for someone to join - send them the link');
          return;
        }
        ui.setRoomStatus(state.players
          .map((p) => p.nick + (p.ready ? ' (ready)' : ''))
          .join(', ') + ' - press ready');
      });

      room.on('go', startRoomRace);
      room.on('over', (msg) => showStandings(msg.standings));
      room.on('error', (err) => ui.setRoomStatus(err.message));

      room.on('closed', () => {
        room = null;
        race = null;
        stopRaceLoop();
        ui.setRoomNickEditable(true);
        ui.setRoomStatus('disconnected - the link still works');
      });

      room.connect();
    }

    function leaveRoom() {
      if (room) room.leave();
      room = null;
      race = null;
      stopRaceLoop();
      setRoomHash('');
      ui.setRoomVisible(false);
      ui.setRoomStatus('');
      ui.setRoomNickEditable(true);
      ui.setRaceVisible(false);
      restart();
    }

    /* The gun has been called. Everyone in the room builds the same
       passage from the one seed, and nobody types until the start stamp
       the server put on it. */
    function startRoomRace(cfg) {
      /* A race needs a finish line, and the room settles its length and
         its toggles. Move the mode bar to match rather than let it show
         something other than what is running. */
      settings = Object.assign({}, settings, {
        mode: 'words',
        wordValue: cfg.count,
        punctuation: cfg.punctuation,
        numbers: cfg.numbers
      });
      TT.storage.saveSettings(settings);
      ui.renderModeBar();

      raceMode = false;
      stopRaceLoop();
      rebuild(TT.netMath.seedRandom(cfg.seed));

      const total = TT.race.totalChars(engine.state.words);
      room.beginRace(total);

      race = { room: true, total, rivalFinished: false, rivalCps: 0 };
      ui.setRaceVisible(true);
      ui.setRaceOpponent('rival');
      ui.setRaceProgress(0, 0);
      ui.setRaceSpeeds(0, 0);
      startRaceLoop();
      focusInput();
    }

    /* The server's ordering is the one that counts: it stamped every
       finish off a single clock, while a rival's last message may still
       have been on the wire when the local guess was made. */
    function showStandings(standings) {
      /* The room moved on while you were still typing. The race is over
         either way, so show what you did rather than leave you racing
         nobody - and do it first, so the placing below lands on a
         results screen that is already up. */
      if (race && race.room) engine.finish();

      const me = room ? room.me() : '';
      let mine = null;

      for (let i = 0; i < standings.length; i++) {
        if (standings[i].id === me) mine = standings[i];
      }

      ui.setRoomStatus(standings
        .map((p) => p.place + '. ' + p.nick + ' ' + TT.format.asWpm(p.wpm))
        .join('   ') + ' - press ready to go again');

      if (mine && !dom.viewResults.hidden) {
        ui.renderRaceOutcome({
          place: mine.place,
          players: standings.length,
          won: mine.place === 1
        });
      }
    }

    /* ------------------------------ engine ------------------------------ */

    engine.on('tick', () => {
      ui.updateLive();
      if (!race) return;
      /* A rival's speed is the rate their last two updates implied; the
         AI's is the figure it was built with. */
      const rivalWpm = race.room ? (race.rivalCps * 60) / 5 : race.opponentWpm;
      ui.setRaceSpeeds(engine.liveStats().wpm, rivalWpm);
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

        if (race.room) {
          room.reportFinish(result);
          /* Everyone who has already crossed is ahead of you and nobody
             who has not can be. The server's standings arrive a moment
             later and rewrite this line. */
          const peers = room.peers();
          const place = TT.netMath.placeOf(room.toRaceSeconds(room.serverNow()), peers);
          raceOutcome = { place, players: peers.length + 1, won: place === 1 };
          ui.setRoomStatus('waiting for the others');
        } else {
          const opponentAt = race.opponent.positionAt(engine.elapsed());
          raceOutcome = { won: opponentAt < race.total, opponentWpm: race.opponentWpm };

          /* Only a real race counts toward calibration, otherwise a string
             of instant finishes would inflate the difficulty ramp. A race
             against people is not one the AI ran, so it never counts. */
          if (recorded) TT.storage.bumpRaceCount();
        }
        race = null;
      }

      if (recorded) {
        /* Samples are only needed for the screen in front of us; keeping
           them out of storage keeps the history entry small. */
        const stored = Object.assign({}, result);
        delete stored.samples;
        if (raceOutcome) {
          stored.race = true;
          stored.won = raceOutcome.won;
          if (raceOutcome.players) stored.players = raceOutcome.players;
          else stored.opponentWpm = raceOutcome.opponentWpm;
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

      /* The passage is up so it can be read; the race has not started. */
      if (beforeGun() && key !== 'Tab') {
        event.preventDefault();
        return;
      }

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
      /* The dialog closes itself on Escape and keeps Tab inside the
         card, so there is nothing to route here. Everything else has to
         stop: keys must not leak into the test behind the panel. */
      if (ui.isHistoryOpen()) return;

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
      if (beforeGun()) return;
      if (event.key === ' ') engine.typeSpace();
      else engine.typeChar(event.key);
    });

    /* ----------------------------- controls ----------------------------- */

    dom.btnRestart.addEventListener('click', restart);
    dom.btnNext.addEventListener('click', restart);

    dom.btnRace.addEventListener('click', toggleRace);

    /* One button for both directions: a room you are not in is one you
       can open, and a room you are in is one you can leave. */
    dom.btnRoom.addEventListener('click', () => {
      if (room || !dom.room.hidden) {
        leaveRoom();
        return;
      }
      const id = TT.netMath.roomIdFromHash(window.location.hash) || TT.netMath.makeRoomId();
      setRoomHash(id);
      openRoom(id);
    });

    dom.btnRoomReady.addEventListener('click', () => {
      if (room) room.setReady(true);
    });

    dom.btnRoomLeave.addEventListener('click', leaveRoom);

    dom.btnRoomLink.addEventListener('click', () => {
      const link = window.location.href;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(
          () => ui.setRoomStatus('link copied'),
          /* Clipboard access can be refused; showing the link is the
             fallback that always works. */
          () => ui.setRoomStatus(link)
        );
        return;
      }
      ui.setRoomStatus(link);
    });

    /* The name travels with the join, so it is read when a room opens
       rather than watched for changes. */
    dom.roomNick.addEventListener('change', () => {
      settings = Object.assign({}, settings, { nick: dom.roomNick.value });
      TT.storage.saveSettings(settings);
    });

    dom.btnHistory.addEventListener('click', () => ui.openHistory());

    /* Clearing the history cannot be undone and there is nowhere to undo
       it from, so the button asks first. The label carries the question:
       a second dialog on top of this one would be worse than the risk. */
    let clearTimer = 0;

    function disarmClear() {
      if (clearTimer) clearTimeout(clearTimer);
      clearTimer = 0;
      dom.btnClearHistory.textContent = 'clear history';
      dom.btnClearHistory.classList.remove('armed');
    }

    dom.btnClearHistory.addEventListener('click', () => {
      if (!clearTimer) {
        dom.btnClearHistory.textContent = 'click again to clear';
        dom.btnClearHistory.classList.add('armed');
        clearTimer = setTimeout(disarmClear, CLEAR_CONFIRM_MS);
        return;
      }
      disarmClear();
      TT.storage.clearHistory();
      ui.renderHistory();
    });

    /* Every way out of the panel lands here - the close button, a click
       on the backdrop, Escape - so the disarm and the return to typing
       only have to be written once. */
    dom.historyModal.addEventListener('close', () => {
      disarmClear();
      focusInput();
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
    /* Fills the history panel up front. openHistory() would do it anyway,
       but until it runs the table is a header row with no data cells
       under it, which is a broken table rather than an empty one. */
    ui.renderHistory();
    renderer.setFocused(false);
    restart();

    dom.roomNick.value = settings.nick;
    /* Opening someone's link is the whole of "joining a room". */
    const linkedRoom = TT.netMath.roomIdFromHash(window.location.hash);
    if (linkedRoom) openRoom(linkedRoom);

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
