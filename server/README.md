# The race server

The only part of LampType that is not a static file, and the only part
that needs deploying. The site works with it switched off: solo play
never opens a socket, and `file://` is unaffected.

One Durable Object per room. It picks the seed, stamps the start, relays
positions at 10Hz, and forgets the room when the last person leaves.
Nothing is written to storage and nothing is logged.

## Run it locally

```
cd server
npx wrangler dev
```

That serves `ws://127.0.0.1:8787`. Point the site at it by editing
`ROOM_URL` in `js/storage.js`, then open `index.html` in two windows.
With `ALLOWED_ORIGINS` empty, `wrangler dev` accepts any origin, which
is what makes a `file://` page work while developing.

## Deploy it

```
cd server
npx wrangler deploy
```

Then, in this order:

1. Put the real origin in `ALLOWED_ORIGINS` in `wrangler.toml` and
   deploy again. Until you do, anyone's page can open a room on your
   worker.
2. Put the deployed `wss://` host in `TT.config.ROOM_URL`
   (`js/storage.js`).
3. Add the same host to `connect-src` in **both** `_headers` and
   `vercel.json`. They must not drift.

`grep -rn "lamptype.example" .` finds all three.

Durable Objects need a Workers plan that offers them. The class here is
declared as `new_sqlite_classes`, which is the backend available without
a paid plan; check the current limits against your own account rather
than trusting this line.

## What it validates

Everything on a socket is a stranger's input.

| rule | why |
| --- | --- |
| names re-cleaned server-side, 16 code points | the client's cleaning is cosmetic only |
| positions must increase | a lane can never run backwards |
| positions capped at 250 wpm implied | the one number a client could lie about to win |
| 25 messages/second, then the socket closes | flood protection |
| 512 bytes per message | nothing legitimate is larger |
| 8 players per room | the lane strip, and the fan-out cost |
| a finish before the gun is dropped | read off the clock, not off the tick that notices it |
| idle sockets dropped after 10 minutes | a room should not outlive the people in it |
| race abandoned after 5 minutes | one person walking away cannot hold the room |

`ponytail:` the client is trusted for its own progress within those
bounds. Replaying the keystroke stream server-side is the upgrade path,
and is only worth writing if a placing ever carries a prize.
