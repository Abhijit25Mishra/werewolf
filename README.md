# Werewolf

A Werewolf party game for friends sitting together: everyone plays on their own phone, and the server is the moderator. One player creates a room and shares a 4-letter code or QR code; everyone joins and taps Ready; the game deals secret roles and runs every night and day.

- 17 roles with balance values, auto or manual line-ups, five reveal modes
- Phones only ever receive what their owner may know (checked by a 200-game bot simulation)
- Closing a tab never loses your seat; reopening the site puts you back in the game

[`PLAN.md`](PLAN.md) is the full design spec. [`docs/PROTOCOL.md`](docs/PROTOCOL.md) and [`docs/ENGINE_API.md`](docs/ENGINE_API.md) pin down the socket protocol and the rules engine (including rulings the plan left open).

## Run it locally

Needs Node 20 or newer.

```bash
npm install
npm start            # http://localhost:3000
```

`PORT=4000 npm start` changes the port. `MIN_PLAYERS=3 npm start` allows tiny test games (real games need 5).

## Test it on one computer

- **Add bots to a room.** Create a room in the browser, then in another terminal run `node scripts/bots.js <ROOM-CODE> 4`. Four bots join, ready up and play by themselves; you play as the fifth player. Ctrl+C removes them.
- **Be several people yourself.** Every tab on the same address shares one seat, so use different addresses for different players: `http://localhost:3000`, `http://127.0.0.1:3000` and your computer's network address (below), plus an incognito window.
- **Use real phones.** On the same Wi-Fi, open `http://<your computer's IP>:3000` (on a Mac: `ipconfig getifaddr en0`). If macOS asks whether `node` may accept incoming connections, allow it.
- **See every screen without a game.** Open `http://localhost:3000/?mock=list`.

## Tests

```bash
npm test             # engine, rooms and a 200-game bot simulation (about 3 minutes)
SIM_GAMES=20 node --test test/simulate.test.js   # a quicker simulation
```

`scripts/e2e-smoke.js` plays one game through the real UI in headless Chrome with bots. It needs Playwright, which isn't a repo dependency.

## Deploy

One Render web service with the settings in `render.yaml` (free plan, `npm ci --omit=dev`, `npm start`, health check `/healthz`). The server pings itself every 2.5 minutes when `RENDER_EXTERNAL_URL` is set, and an UptimeRobot monitor on `/healthz` every 5 minutes keeps it awake. A deploy restarts the server and ends games in progress, so don't push during a game. See PLAN.md, Deployment.

## Decisions made during the build

Rulings the plan left open are recorded in `docs/ENGINE_API.md` ("Rulings where PLAN.md is silent"). Two changes from the plan:

- With 5 or more players, the wolf team must be small enough that one night kill can't give them parity, so every game reaches at least one vote.
- A vote where Skip ties for the most votes is reported as a tie (nobody is eliminated either way).
