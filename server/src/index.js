/* =================================================================
   The LampType race server.

   One Durable Object per room. It is a relay with a clock and a
   rulebook, and deliberately nothing else: it never generates the
   passage, never scores a test, and never stores anything. It picks a
   seed, stamps the start, fans positions out at 10Hz, and forgets the
   room when the last person leaves.

   It is the only thing in this project that is not a static file, and
   it is a separate deploy: `wrangler deploy` from this directory. The
   site keeps working with it switched off - solo play never opens a
   socket.

   Everything arriving on a socket is a stranger's input. Names are
   re-cleaned here whatever the client claims to have done, positions
   must move forward and must not imply a speed no human reaches, and a
   socket that floods gets closed.
   ================================================================= */

const ROOM_MAX = 8;              // players per room
const NICK_MAX = 16;

const COUNTDOWN_MS = 3000;       // between the last "ready" and the gun
const TICK_MS = 100;             // position broadcasts, 10Hz
const RACE_CAP_MS = 5 * 60000;   // a straggler cannot hold the room open
const IDLE_MS = 10 * 60000;      // a silent socket is dropped
const SWEEP_MS = 30000;

const MSG_MAX_BYTES = 512;
const RATE_LIMIT = 25;           // messages per second, per socket

/* No human types this fast, so anything above it is a client lying
   about where it has got to. */
const MAX_WPM = 250;

/* Elapsed time is floored before dividing by it: at the instant the gun
   goes the divisor is nearly zero and every position looks impossible. */
const MIN_ELAPSED_S = 0.5;

const WORD_COUNTS = [10, 25, 50, 100];

/* The client cleans names too, but only so that what you typed is what
   you see. This copy is the one that decides. */
function cleanNick(raw) {
  const source = String(raw == null ? '' : raw);
  let out = '';

  /* C0, DEL and the C1 block go; everything else stays. A name in
     Japanese or Arabic, or one with an accent in it, is somebody's name
     - stripping it back to ASCII would be the bug, not the fix.

     Tab and newline are control characters too, but they are the ones
     that mean "a gap here". Dropping them would run two words of a name
     together, so they become the space they stand for and the collapse
     below tidies up after them.

     This has to stay identical to the copy in js/net.js: if the two
     disagree, the name you typed is not the name the room shows. */
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

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

function makeId() {
  return crypto.randomUUID().slice(0, 8);
}

/* Only pages we serve may open a socket. An unset list means local
   development, where there is no origin worth checking. */
function originAllowed(request, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '').trim();
  if (!allowed) return true;

  const origin = request.headers.get('Origin') || '';
  return allowed.split(',').some((o) => o.trim() === origin);
}

export class Room {
  constructor(state) {
    this.state = state;

    /* ponytail: plain accept() rather than the hibernation API, so room
       state is ordinary memory. A room with someone in it should be in
       memory; the day idle rooms cost real money, move to
       state.acceptWebSocket() and persist what is below. */
    this.sessions = new Map();   // ws -> { id, lastSeen, windowStart, count }
    this.players = new Map();    // id -> player

    this.status = 'lobby';       // lobby | countdown | racing | over
    this.startAt = null;
    this.seed = 0;
    this.config = null;          // { count, punctuation, numbers }

    this.tick = null;
    this.sweep = null;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket', { status: 426 });
    }

    if (this.players.size >= ROOM_MAX) {
      return new Response('room is full', { status: 409 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    this.open(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ------------------------------ sockets ------------------------------ */

  open(ws) {
    this.sessions.set(ws, { id: '', lastSeen: Date.now(), windowStart: 0, count: 0 });

    ws.addEventListener('message', (event) => {
      try {
        this.onMessage(ws, event.data);
      } catch (err) {
        /* One bad message must never take the room down with it. */
        this.send(ws, { t: 'error', message: 'that message could not be read' });
      }
    });

    ws.addEventListener('close', () => this.close(ws));
    ws.addEventListener('error', () => this.close(ws));

    this.startSweep();
  }

  close(ws) {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (!session) return;

    if (session.id) this.players.delete(session.id);

    if (this.sessions.size === 0) {
      this.stopTick();
      this.stopSweep();
      this.status = 'lobby';
      this.startAt = null;
      /* The room is empty, so the next person through the door settles
         what it races over rather than inheriting a stranger's choice. */
      this.config = null;
      return;
    }

    this.broadcastRoom();
    this.maybeStart();
    this.maybeFinish();
  }

  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      /* The socket went away between the check and the write. */
    }
  }

  broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.sessions.keys()) {
      try {
        ws.send(text);
      } catch (err) {
        /* Its close event will clean it up. */
      }
    }
  }

  roster() {
    return Array.from(this.players.values()).map((p) => ({
      id: p.id,
      nick: p.nick,
      ready: p.ready,
      done: p.finishedAt != null,
      wpm: p.wpm
    }));
  }

  broadcastRoom() {
    this.broadcast({
      t: 'room',
      status: this.status,
      players: this.roster()
    });
  }

  /* ----------------------------- messages ----------------------------- */

  onMessage(ws, data) {
    const session = this.sessions.get(ws);
    if (!session) return;

    if (typeof data !== 'string' || data.length > MSG_MAX_BYTES) return;

    const now = Date.now();
    session.lastSeen = now;

    /* A fixed window is coarse but it only has to stop a flood, and it
       costs two integers per socket. */
    if (now - session.windowStart >= 1000) {
      session.windowStart = now;
      session.count = 0;
    }
    if (++session.count > RATE_LIMIT) {
      this.send(ws, { t: 'error', message: 'too many messages' });
      try { ws.close(1008, 'rate limit'); } catch (err) { /* going anyway */ }
      this.close(ws);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data);
    } catch (err) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    /* The clock exchange is answered before anything else and without
       needing to have joined: it is the cheapest message here and the
       reply must not queue behind room bookkeeping. */
    if (msg.t === 'ping') {
      this.send(ws, { t: 'pong', t0: msg.t0, now: Date.now() });
      return;
    }

    if (msg.t === 'join') return this.onJoin(ws, session, msg);

    const player = session.id ? this.players.get(session.id) : null;
    if (!player) return;

    switch (msg.t) {
      case 'ready':  return this.onReady(player, msg);
      case 'pos':    return this.onPos(player, msg);
      case 'done':   return this.onDone(player, msg);
      case 'rematch':return this.onRematch();
      default:       return;
    }
  }

  onJoin(ws, session, msg) {
    if (session.id) return;                       // already in
    if (this.players.size >= ROOM_MAX) {
      this.send(ws, { t: 'error', message: 'that room is full' });
      try { ws.close(1013, 'full'); } catch (err) { /* going anyway */ }
      return;
    }

    const id = makeId();
    session.id = id;

    this.players.set(id, {
      id,
      nick: cleanNick(msg.nick),
      ready: false,
      pos: 0,
      wpm: 0,
      accuracy: 0,
      finishedAt: null
    });

    /* The first person through the door settles what the room is
       racing over; everyone after them joins that race rather than
       renegotiating it. */
    if (!this.config) {
      this.config = {
        count: WORD_COUNTS.indexOf(Number(msg.count)) !== -1 ? Number(msg.count) : 25,
        punctuation: !!msg.punctuation,
        numbers: !!msg.numbers
      };
    }

    this.send(ws, { t: 'welcome', you: id, now: Date.now() });

    /* Somebody arriving mid-race sees the room they walked into rather
       than a lobby that is not there. */
    if (this.status === 'countdown' || this.status === 'racing') {
      this.send(ws, Object.assign({ t: 'go', startAt: this.startAt, seed: this.seed }, this.config));
    }

    this.broadcastRoom();
  }

  onReady(player, msg) {
    if (this.status !== 'lobby' && this.status !== 'over') return;
    player.ready = !!msg.ready;
    this.broadcastRoom();
    this.maybeStart();
  }

  /* Positions are the only thing a client can lie about that would
     change the outcome, so this is where the lying is bounded. */
  onPos(player, msg) {
    if (this.status !== 'countdown' && this.status !== 'racing') return;
    if (player.finishedAt != null) return;

    const pos = Number(msg.pos);
    if (!isFinite(pos) || pos < 0) return;

    /* Never backwards. */
    if (pos <= player.pos) return;

    const elapsed = Math.max(MIN_ELAPSED_S, (Date.now() - this.startAt) / 1000);
    const ceiling = (MAX_WPM * 5 * elapsed) / 60;
    player.pos = Math.min(pos, ceiling);
  }

  onDone(player, msg) {
    if (this.status !== 'racing' && this.status !== 'countdown') return;
    if (player.finishedAt != null) return;
    /* The clock, not the tick that notices it: a finish cannot predate
       the gun even if the 100ms tick has not flipped the status yet. */
    if (Date.now() < this.startAt) return;

    player.finishedAt = Date.now();
    player.wpm = clamp(msg.wpm, 0, 400);
    player.accuracy = clamp(msg.accuracy, 0, 100);

    this.broadcast({
      t: 'done',
      id: player.id,
      at: player.finishedAt,
      wpm: player.wpm,
      accuracy: player.accuracy
    });

    this.maybeFinish();
  }

  onRematch() {
    if (this.status !== 'over') return;
    this.status = 'lobby';
    this.startAt = null;
    for (const p of this.players.values()) {
      p.ready = false;
      p.pos = 0;
      p.finishedAt = null;
      p.wpm = 0;
      p.accuracy = 0;
    }
    this.broadcastRoom();
  }

  /* ------------------------------- race ------------------------------- */

  maybeStart() {
    if (this.status !== 'lobby' && this.status !== 'over') return;
    if (this.players.size < 2) return;

    for (const p of this.players.values()) {
      if (!p.ready) return;
    }

    this.status = 'countdown';
    this.startAt = Date.now() + COUNTDOWN_MS;
    /* A 31-bit integer, because the client seeds a 32-bit generator
       with it and both sides have to read the same number. */
    this.seed = Math.floor(Math.random() * 0x7fffffff);

    for (const p of this.players.values()) {
      p.pos = 0;
      p.finishedAt = null;
      p.ready = false;
    }

    this.broadcast(Object.assign(
      { t: 'go', startAt: this.startAt, seed: this.seed },
      this.config
    ));
    this.broadcastRoom();
    this.startTick();
  }

  startTick() {
    if (this.tick) return;
    this.tick = setInterval(() => {
      if (this.status !== 'countdown' && this.status !== 'racing') return;

      const now = Date.now();
      if (now >= this.startAt) this.status = 'racing';

      /* One clock reading for the whole batch, so every lane in this
         frame is measured from the same instant. */
      const rows = [];
      for (const p of this.players.values()) {
        if (p.finishedAt == null) rows.push([p.id, Math.round(p.pos)]);
      }
      if (rows.length) this.broadcast({ t: 'pos', at: now, p: rows });

      /* Nobody waits forever on someone who wandered off mid-race. */
      if (now - this.startAt > RACE_CAP_MS) this.finish();
    }, TICK_MS);
  }

  stopTick() {
    if (this.tick) {
      clearInterval(this.tick);
      this.tick = null;
    }
  }

  maybeFinish() {
    if (this.status !== 'racing' && this.status !== 'countdown') return;
    if (this.players.size === 0) return;

    for (const p of this.players.values()) {
      if (p.finishedAt == null) return;
    }
    this.finish();
  }

  finish() {
    this.stopTick();
    this.status = 'over';

    const standings = Array.from(this.players.values())
      .sort((a, b) => {
        /* Whoever crossed, in the order they crossed; then whoever got
           furthest without crossing. */
        if (a.finishedAt != null && b.finishedAt != null) return a.finishedAt - b.finishedAt;
        if (a.finishedAt != null) return -1;
        if (b.finishedAt != null) return 1;
        return b.pos - a.pos;
      })
      .map((p, i) => ({
        id: p.id,
        nick: p.nick,
        wpm: p.wpm,
        accuracy: p.accuracy,
        finished: p.finishedAt != null,
        place: i + 1
      }));

    this.broadcast({ t: 'over', standings });
    this.broadcastRoom();
  }

  /* ------------------------------ upkeep ------------------------------ */

  startSweep() {
    if (this.sweep) return;
    this.sweep = setInterval(() => {
      const now = Date.now();
      for (const [ws, session] of this.sessions) {
        if (now - session.lastSeen > IDLE_MS) {
          try { ws.close(1000, 'idle'); } catch (err) { /* going anyway */ }
          this.close(ws);
        }
      }
      if (this.sessions.size === 0) this.stopSweep();
    }, SWEEP_MS);
  }

  stopSweep() {
    if (this.sweep) {
      clearInterval(this.sweep);
      this.sweep = null;
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    }

    const match = /^\/room\/([a-z0-9]{4,16})$/.exec(url.pathname);
    if (!match) return new Response('not found', { status: 404 });

    if (!originAllowed(request, env)) {
      return new Response('forbidden', { status: 403 });
    }

    /* The room id is the object's name, so everyone who types the same
       link lands inside the same object. */
    const id = env.ROOMS.idFromName(match[1]);
    return env.ROOMS.get(id).fetch(request);
  }
};
