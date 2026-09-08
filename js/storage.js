/* =================================================================
   storage.js - settings, test history, and derived personal bests.

   Every read and write is wrapped: if localStorage is unavailable
   (private browsing, storage disabled, quota exceeded) the app still
   runs, it just forgets everything between visits.

   Personal bests are DERIVED from history rather than stored on their
   own, so the two can never drift out of sync.
   ================================================================= */

window.TT = window.TT || {};

(function (TT) {
  'use strict';

  /* Shared config lives here because storage is what validates
     persisted values against it on load. */
  TT.config = {
    MODES: ['time', 'words', 'single'],
    TIME_VALUES: [15, 30, 60, 120],
    WORD_VALUES: [10, 25, 50, 100],
    /* '1 word' is a timed mode, so it shares the time lengths. */
    SINGLE_VALUES: [15, 30, 60, 120],
    THEMES: ['lamp', 'paper', 'ink', 'linen', 'oxide', 'iris', 'sakura'],
    /* Sakura ships light and dark variants; 'auto' follows the OS. */
    COLOR_MODES: ['auto', 'light', 'dark'],
    HISTORY_LIMIT: 50
  };

  /* What each mode is called on screen, and which setting holds its
     length. Keeping both in one table means a new mode is one entry. */
  const MODES = {
    time:   { label: 'time',   setting: 'timeValue',   values: 'TIME_VALUES' },
    words:  { label: 'words',  setting: 'wordValue',   values: 'WORD_VALUES' },
    single: { label: '1 word', setting: 'singleValue', values: 'SINGLE_VALUES' }
  };

  /* Modes that end on the clock rather than on a word count. */
  function isTimed(mode) {
    return mode === 'time' || mode === 'single';
  }

  function modeInfo(mode) {
    return MODES[mode] || MODES.time;
  }

  function valuesFor(mode) {
    return TT.config[modeInfo(mode).values];
  }

  function settingFor(mode) {
    return modeInfo(mode).setting;
  }

  const SETTINGS_KEY = 'tt:settings';
  const HISTORY_KEY = 'tt:history';
  /* History is capped at 50 entries, so the race tally cannot be
     derived from it the way personal bests are - it gets its own key. */
  const RACES_KEY = 'tt:races';

  const DEFAULTS = {
    mode: 'time',
    timeValue: 30,
    wordValue: 25,
    singleValue: 30,
    punctuation: false,
    numbers: false,
    theme: 'lamp',
    colorMode: 'auto'
  };

  function read(key) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function write(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      return false;
    }
  }

  function remove(key) {
    try {
      window.localStorage.removeItem(key);
      return true;
    } catch (err) {
      return false;
    }
  }

  /* Never trust what came out of storage: an older build, a hand-edited
     value or a corrupt entry must not be able to break the test. */
  function sanitizeSettings(raw) {
    const s = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
    const cfg = TT.config;

    if (cfg.MODES.indexOf(s.mode) === -1) s.mode = DEFAULTS.mode;
    if (cfg.TIME_VALUES.indexOf(s.timeValue) === -1) s.timeValue = DEFAULTS.timeValue;
    if (cfg.WORD_VALUES.indexOf(s.wordValue) === -1) s.wordValue = DEFAULTS.wordValue;
    if (cfg.SINGLE_VALUES.indexOf(s.singleValue) === -1) s.singleValue = DEFAULTS.singleValue;
    if (cfg.THEMES.indexOf(s.theme) === -1) s.theme = DEFAULTS.theme;
    if (cfg.COLOR_MODES.indexOf(s.colorMode) === -1) s.colorMode = DEFAULTS.colorMode;
    s.punctuation = !!s.punctuation;
    s.numbers = !!s.numbers;

    return s;
  }

  function loadSettings() {
    return sanitizeSettings(read(SETTINGS_KEY));
  }

  function saveSettings(settings) {
    return write(SETTINGS_KEY, sanitizeSettings(settings));
  }

  function loadHistory() {
    const raw = read(HISTORY_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter((r) => r && typeof r === 'object' && typeof r.wpm === 'number');
  }

  function addResult(result) {
    const history = loadHistory();
    history.unshift(result);
    history.length = Math.min(history.length, TT.config.HISTORY_LIMIT);
    write(HISTORY_KEY, history);
    return history;
  }

  function clearHistory() {
    remove(HISTORY_KEY);
    remove(RACES_KEY);
    return [];
  }

  function loadRaceCount() {
    const raw = read(RACES_KEY);
    const n = raw && typeof raw.completed === 'number' ? Math.floor(raw.completed) : 0;
    return isFinite(n) && n > 0 ? n : 0;
  }

  function bumpRaceCount() {
    const next = loadRaceCount() + 1;
    write(RACES_KEY, { completed: next });
    return next;
  }

  /* Identity of a "comparable" test: same mode, same length, same toggles. */
  function modeKey(result) {
    return [
      result.mode,
      result.modeValue,
      result.punctuation ? 'p' : '-',
      result.numbers ? 'n' : '-'
    ].join(':');
  }

  function modeLabel(result) {
    const flags = [];
    if (result.punctuation) flags.push('punctuation');
    if (result.numbers) flags.push('numbers');
    const base = modeInfo(result.mode).label + ' ' + result.modeValue;
    return flags.length ? base + ' + ' + flags.join(' + ') : base;
  }

  /* Best previous run of the same kind, or null if this is the first. */
  function bestFor(history, key) {
    let best = null;
    for (let i = 0; i < history.length; i++) {
      if (modeKey(history[i]) !== key) continue;
      if (!best || history[i].wpm > best.wpm) best = history[i];
    }
    return best;
  }

  /* One entry per distinct mode key, ordered so the grid reads
     time-then-words, shortest first. */
  function personalBests(history) {
    const byKey = new Map();

    for (let i = 0; i < history.length; i++) {
      const r = history[i];
      const key = modeKey(r);
      const current = byKey.get(key);
      if (!current || r.wpm > current.wpm) byKey.set(key, r);
    }

    const order = TT.config.MODES;
    return Array.from(byKey.values()).sort((a, b) => {
      if (a.mode !== b.mode) return order.indexOf(a.mode) - order.indexOf(b.mode);
      if (a.modeValue !== b.modeValue) return a.modeValue - b.modeValue;
      return modeKey(a).localeCompare(modeKey(b));
    });
  }

  TT.storage = {
    DEFAULTS,
    isTimed,
    modeInfo,
    valuesFor,
    settingFor,
    loadSettings,
    saveSettings,
    loadHistory,
    addResult,
    clearHistory,
    loadRaceCount,
    bumpRaceCount,
    modeKey,
    modeLabel,
    bestFor,
    personalBests
  };
})(window.TT);
