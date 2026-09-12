/* =================================================================
   net.js - the shared race.

   Three problems, and nothing else:

     the same passage   every browser in a room seeds the word
                        generator with one number from the server, so
                        TT.words.generate builds an identical list
                        without the list ever crossing the wire.

     the same clock     two machines do not agree on the time. One
                        NTP-style exchange over the socket yields an
                        offset, the server stamps the start, and from
                        then on every browser measures the race from
                        the same instant. performance.now() is never
                        compared across machines - its origin is the
                        moment that tab opened.

     the other lanes    a remote typist satisfies exactly the shape
                        js/race.js already returns: an object with
                        positionAt(elapsedSeconds). Updates land about
                        ten times a second; between them the lane is a
                        closed-form extrapolation from the last one,
                        never an accumulation of frame deltas. That is
                        the same fairness rule the AI opponent follows,
                        and it is why a stalled tab cannot lose you a
                        race you were winning.

   No DOM in here, which is what lets tests.html drive it.
   ================================================================= */

window.TT = window.TT || {};

(function (TT) {
  'use strict';

  const NICK_MAX = 16;
  const ROOM_MAX = 8;

  /* How long a lane may keep moving on its last known speed after its
     updates stop. Long enough to ride out a hiccup, short enough that a
     dropped connection cannot coast across the finish line. */
  const MAX_COAST = 2;

  /* Two updates closer together than this give no usable rate - the
     divisor is small enough that ordinary jitter dominates it. */
  const MIN_STEP = 0.02;

  const POS_HZ = 10;              // outbound position updates per second
  const PING_COUNT = 5;           // clock samples taken on connect
  const PING_GAP_MS = 120;

  /* No look-alike characters: a room id gets read aloud and typed in. */
  const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
  const ID_LENGTH = 8;
  const ID_RE = /^[a-z0-9]{4,16}$/;

  /* ----------------------------- the seed -----------------------------
     mulberry32. Four lines, no dependency, and identical in every
     browser because it only uses 32-bit integer maths. */

  function seedRandom(seed) {
    let a = (Number(seed) | 0) || 1;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ----------------------------- the clock -----------------------------
     Each sample is one round trip: we sent at t0, the server said it was
     `server`, the reply landed at t1. Assuming the two legs are
     symmetric, the server's clock read (t0 + t1) / 2 on ours.

     The median rather than the mean, because one round trip delayed by a
     garbage collection would drag an average with it and the median
     simply steps over it. */

  function clockOffset(samples) {
    const offsets = [];

    const list = samples || [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s) continue;
      if (!isFinite(s.t0) || !isFinite(s.server) || !isFinite(s.t1)) continue;
      if (s.t1 < s.t0) continue;
      offsets.push(s.server - (s.t0 + s.t1) / 2);
    }

    if (offsets.length === 0) return 0;
    offsets.sort((a, b) => a - b);

    const mid = offsets.length >> 1;
    return offsets.length % 2
      ? offsets[mid]
      : (offsets[mid - 1] + offsets[mid]) / 2;
  }

  /* ------------------------------ a lane ------------------------------
     Same contract as TT.race.createOpponent: positionAt(seconds).
     `at` is race time - seconds since the shared start - not wall time,
     so a lane is testable without a clock at all. */

  function createPeer(id, nick, total) {
    const finish = total > 0 ? total : 0;
    let last = null;   // { pos, at }
    let cps = 0;

    const peer = {
      id,
      nick,
      wpm: 0,
      accuracy: 0,
      finishedAt: null,   // race seconds, set when they cross the line
      gone: false,

      update(pos, at) {
        const t = Math.max(0, Number(at) || 0);
        /* A packet that overtook a newer one carries nothing we want:
           the newer position has already landed. */
        if (last && t < last.at) return;

        let p = Math.min(finish, Math.max(0, Number(pos) || 0));
        if (last) {
          /* A lane never runs backwards, whatever arrives. */
          p = Math.max(last.pos, p);
          const dt = t - last.at;
          if (dt >= MIN_STEP) cps = (p - last.pos) / dt;
        }
        last = { pos: p, at: t };
      },

      positionAt(seconds) {
        if (!last) return 0;
        const dt = Math.min(MAX_COAST, Math.max(0, (Number(seconds) || 0) - last.at));
        return Math.min(finish, last.pos + cps * dt);
      },

      /* Exposed for the tests; nothing else should need it. */
      rate() {
        return cps;
      }
    };

    return peer;
  }

  /* Whoever is furthest along right now. One lane is shown against
     yours, and it is always the one you are actually racing. */
  function leaderAt(peers, seconds) {
    let best = null;
    let bestPos = -1;

    const list = peers || [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || p.gone) continue;
      const at = p.positionAt(seconds);
      if (at > bestPos) {
        bestPos = at;
        best = p;
      }
    }

    return { peer: best, pos: bestPos < 0 ? 0 : bestPos };
  }

  /* Your placing is decided the instant you cross: everyone who already
     crossed is ahead of you, and nobody who has not cannot be.

     ponytail: this reads the finishes that have reached us. A rival who
     crossed a few milliseconds before you, whose message is still on the
     wire, would be counted behind - the server's own ordering is the
     tiebreaker to trust if placings ever carry a prize. */
  function placeOf(finishedAt, peers) {
    let ahead = 0;

    const list = peers || [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p && p.finishedAt != null && p.finishedAt < finishedAt) ahead++;
    }

    return ahead + 1;
  }

  /* ----------------------------- identity -----------------------------
     The server cleans names again and does not trust this. Doing it here
     too is only so that what you typed is what you see. */

  function cleanNick(raw) {
    const source = String(raw == null ? '' : raw);
    let out = '';

    /* C0, DEL and the C1 block go; everything else stays. A name in
       Japanese or Arabic, or one with an accent in it, is somebody's
       name - stripping it back to ASCII would be the bug, not the fix.

       Tab and newline are control characters too, but they are the ones
       that mean "a gap here". Dropping them would run two words of a
       name together, so they become the space they stand for and the
       collapse below tidies up after them. */
    for (let i = 0; i < source.length; i++) {
      const code = source.charCodeAt(i);
      if (code >= 9 && code <= 13) { out += ' '; continue; }
      if (code < 32 || (code >= 127 && code <= 159)) continue;
      out += source.charAt(i);
    }

    out = out.replace(/\s+/g, ' ').trim();
    /* Counted in code points, so the cut cannot land inside a surrogate
       pair and leave half a character behind. */
    return Array.from(out).slice(0, NICK_MAX).join('') || 'guest';
  }

  function makeRoomId(bytes) {
    let src = bytes;
    if (!src) {
      src = new Uint8Array(ID_LENGTH);
      if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(src);
      } else {
        for (let i = 0; i < ID_LENGTH; i++) src[i] = Math.floor(Math.random() * 256);
      }
    }

    let out = '';
    for (let i = 0; i < ID_LENGTH; i++) {
      out += ID_ALPHABET.charAt(src[i % src.length] % ID_ALPHABET.length);
    }
    return out;
  }

  /* A room id off the URL is a stranger's string until it has been
     through here. */
  function roomIdFromHash(hash) {
    const m = /[#&?]r=([^&]*)/.exec(String(hash || ''));
    if (!m) return '';
    let id = '';
    try {
      id = decodeURIComponent(m[1]).toLowerCase();
    } catch (err) {
      return '';
    }
    return ID_RE.test(id) ? id : '';
  }

  /* ------------------------------- room -------------------------------
     Owns the socket and the roster, and emits the way the engine does so
     that main.js wires it the same way it wires everything else.

     Events: open | room | countdown | go | done | over | error | closed
     ================================================================= */

  function createRoom(opts) {
    const o = opts || {};
    const listeners = Object.create(null);

    const nick = cleanNick(o.nick);
    const id = String(o.id || '');
    const Socket = o.socket || window.WebSocket;

    let ws = null;
    let offset = 0;              // server clock minus ours, in ms
    let samples = [];
    let pingTimer = null;

    let me = '';
    let status = 'connecting';   // connecting | lobby | countdown | racing | over
    let players = [];            // [{ id, nick, ready }]
    let peers = [];              // createPeer objects, everyone but you
    let byId = Object.create(null);

    let startAt = null;          // server ms
    let race = null;             // { seed, count, punctuation, numbers }
    let total = 0;

    let lastSentPos = -1;
    let lastSentAt = 0;

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

    function send(msg) {
      if (!ws || ws.readyState !== 1) return false;
      try {
        ws.send(JSON.stringify(msg));
        return true;
      } catch (err) {
        return false;
      }
    }

    /* ---------------------------- the clock ---------------------------- */

    function serverNow() {
      return Date.now() + offset;
    }

    /* Milliseconds until the gun. Negative once it has gone off. */
    function msUntilStart() {
      return startAt == null ? Infinity : startAt - serverNow();
    }

    /* A server stamp, expressed as seconds since the start of the race -
       the same number engine.elapsed() reports on every machine. */
    function toRaceSeconds(stampMs) {
      if (startAt == null) return 0;
      return (Number(stampMs) - startAt) / 1000;
    }

    function syncClock() {
      let sent = 0;
      samples = [];

      pingTimer = setInterval(() => {
        if (sent >= PING_COUNT || !ws || ws.readyState !== 1) {
          clearInterval(pingTimer);
          pingTimer = null;
          return;
        }
        sent++;
        send({ t: 'ping', t0: Date.now() });
      }, PING_GAP_MS);

      send({ t: 'ping', t0: Date.now() });
      sent++;
    }

    /* ---------------------------- the roster ---------------------------- */

    function rebuildPeers() {
      const next = [];
      const index = Object.create(null);

      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (p.id === me) continue;
        /* Keep the object across roster updates, so a lane mid-race does
           not lose the position it has already been given. */
        const existing = byId[p.id];
        const peer = existing || createPeer(p.id, p.nick, total);
        peer.nick = p.nick;
        next.push(peer);
        index[p.id] = peer;
      }

      /* Anyone who left stops moving where they stood. */
      for (let i = 0; i < peers.length; i++) {
        if (!index[peers[i].id]) peers[i].gone = true;
      }

      peers = next;
      byId = index;
    }

    function you() {
      for (let i = 0; i < players.length; i++) {
        if (players[i].id === me) return players[i];
      }
      return null;
    }

    /* ---------------------------- incoming ---------------------------- */

    function onMessage(event) {
      let msg = null;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      switch (msg.t) {
        case 'pong': {
          samples.push({ t0: msg.t0, server: msg.now, t1: Date.now() });
          offset = clockOffset(samples);
          break;
        }

        case 'welcome': {
          me = String(msg.you || '');
          break;
        }

        case 'room': {
          status = String(msg.status || 'lobby');
          players = Array.isArray(msg.players) ? msg.players : [];
          rebuildPeers();
          emit('room', { status, players, me, you: you() });
          break;
        }

        case 'go': {
          startAt = Number(msg.startAt);
          race = {
            seed: Number(msg.seed) | 0,
            count: Number(msg.count) || 0,
            punctuation: !!msg.punctuation,
            numbers: !!msg.numbers
          };
          status = 'countdown';
          lastSentPos = -1;
          lastSentAt = 0;
          for (let i = 0; i < peers.length; i++) peers[i].finishedAt = null;
          emit('go', Object.assign({ startAt }, race));
          break;
        }

        case 'pos': {
          /* One stamp for the whole batch: the server read its clock
             once, so every lane in this frame shares an instant. */
          const at = toRaceSeconds(msg.at);
          const list = Array.isArray(msg.p) ? msg.p : [];
          for (let i = 0; i < list.length; i++) {
            const row = list[i];
            if (!row) continue;
            const peer = byId[row[0]];
            if (peer) peer.update(row[1], at);
          }
          status = 'racing';
          break;
        }

        case 'done': {
          const peer = byId[msg.id];
          if (peer) {
            peer.finishedAt = toRaceSeconds(msg.at);
            peer.wpm = Number(msg.wpm) || 0;
            peer.accuracy = Number(msg.accuracy) || 0;
            /* They are over the line; pin the lane there. */
            peer.update(total, peer.finishedAt);
          }
          emit('done', { id: msg.id, wpm: Number(msg.wpm) || 0 });
          break;
        }

        case 'over': {
          status = 'over';
          emit('over', { standings: Array.isArray(msg.standings) ? msg.standings : [] });
          break;
        }

        case 'error': {
          emit('error', { message: String(msg.message || 'something went wrong') });
          break;
        }

        default:
          break;
      }
    }

    /* ---------------------------- outgoing ---------------------------- */

    /* Called every animation frame; throttled to POS_HZ here rather than
       at the call site, so the render loop stays about rendering. */
    function reportPosition(chars) {
      if (status !== 'countdown' && status !== 'racing') return;

      const now = Date.now();
      const pos = Math.round(Number(chars) || 0);
      if (pos === lastSentPos) return;
      if (now - lastSentAt < 1000 / POS_HZ) return;

      lastSentPos = pos;
      lastSentAt = now;
      send({ t: 'pos', pos });
    }

    function reportFinish(result) {
      send({
        t: 'done',
        wpm: Number(result && result.wpm) || 0,
        accuracy: Number(result && result.accuracy) || 0
      });
    }

    function setReady(ready) {
      send({ t: 'ready', ready: !!ready });
    }

    function rematch() {
      send({ t: 'rematch' });
    }

    /* Called once the engine has built the passage, because only then is
       the character count known - and every browser in the room reaches
       the same number from the same seed. */
    function beginRace(chars) {
      total = Math.max(0, Number(chars) || 0);
      const fresh = [];
      const index = Object.create(null);
      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (p.id === me) continue;
        const peer = createPeer(p.id, p.nick, total);
        fresh.push(peer);
        index[p.id] = peer;
      }
      peers = fresh;
      byId = index;
    }

    function connect() {
      const base = String(o.url || '').replace(/\/+$/, '');
      let socket = null;
      try {
        socket = new Socket(base + '/room/' + encodeURIComponent(id));
      } catch (err) {
        emit('error', { message: 'could not reach the race server' });
        return;
      }
      ws = socket;

      ws.onopen = () => {
        status = 'lobby';
        /* The room adopts the first arrival's length and toggles, so
           they travel with the join rather than needing a negotiation. */
        send({
          t: 'join',
          nick,
          count: o.count,
          punctuation: !!o.punctuation,
          numbers: !!o.numbers
        });
        syncClock();
        emit('open', {});
      };

      ws.onmessage = onMessage;

      ws.onerror = () => {
        emit('error', { message: 'the connection to the race server failed' });
      };

      /* ponytail: a dropped socket ends the race rather than trying to
         resume it. Reconnect-and-catch-up is worth writing the day rooms
         outlive a single test. */
      ws.onclose = () => {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        ws = null;
        status = 'closed';
        emit('closed', {});
      };
    }

    function leave() {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      const socket = ws;
      ws = null;
      if (socket) {
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        try { socket.close(); } catch (err) { /* already gone */ }
      }
      status = 'closed';
    }

    return {
      on,
      off,
      connect,
      leave,
      setReady,
      rematch,
      beginRace,
      reportPosition,
      reportFinish,
      msUntilStart,
      serverNow,
      toRaceSeconds,
      id: () => id,
      me: () => me,
      nick: () => nick,
      status: () => status,
      players: () => players.slice(),
      peers: () => peers.slice(),
      config: () => race,
      offset: () => offset
    };
  }

  TT.netMath = {
    NICK_MAX,
    ROOM_MAX,
    MAX_COAST,
    ID_LENGTH,
    seedRandom,
    clockOffset,
    createPeer,
    leaderAt,
    placeOf,
    cleanNick,
    makeRoomId,
    roomIdFromHash
  };

  TT.createRoom = createRoom;
})(window.TT);
