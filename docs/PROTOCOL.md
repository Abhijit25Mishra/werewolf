# Protocol contract

The server (`server.js`, `src/`) and the client (`public/`) both implement exactly this file. PLAN.md explains the why; this file fixes the names and shapes. If either side needs a change, change this file first and say so in your report. Clients must ignore unknown fields.

## Transport

- Socket.IO 4, same origin, default path. The page loads `/socket.io/socket.io.js`.
- Handshake: `io({ auth: (cb) => cb(savedSeat() || {}) })`, where a saved seat is `{ code, playerId, token }`.
- On connection with a valid seat, the server joins the socket to rooms `p:<playerId>` and `r:<code>` and emits `state` at once. With a saved seat that is no longer valid it emits `seat:invalid`, and the client forgets the seat and shows Home. With no seat, nothing is sent until the client creates or joins.
- Every client-to-server event uses an acknowledgement: `socket.timeout(8000).emit(event, payload, (err, res) => …)`. `res` is `{ ok: true, ...extra }` or `{ ok: false, error: "Human-readable message", code: "CODE" }`.
- After any change, the server sends each affected player a fresh `state`. There are no incremental events.

## Error codes

| Code | Meaning |
| --- | --- |
| `NO_ROOM` | No room with that code |
| `ROOM_FULL` | 20 players already |
| `NAME_TAKEN` | Name held by a connected player |
| `NAME_TAKEN_OFFLINE` | Name held by an offline seat; the client offers `room:reclaim` |
| `BAD_NAME` | Empty, too long (over 16 characters after trimming) or invalid |
| `BAD_CODE` | Not 4 letters from the code alphabet |
| `BAD_SEAT` | playerId or token wrong |
| `NOT_IN_ROOM` | The socket has no bound seat |
| `NOT_HOST` | Host-only action |
| `NOT_ALLOWED` | Not allowed in this phase, stage or task |
| `BAD_TARGET` | Target not legal for this task |
| `BAD_SETTINGS` | Settings patch out of range |
| `RATE_LIMITED` | More than 10 events a second |
| `SERVER_FULL` | 200 rooms already |
| `BAD_REQUEST` | Malformed payload |

## HTTP

- `GET /healthz` returns 200 with body `ok` at once.
- `GET /api/roles` returns `{ roles: RoleInfo[] }`, static and cacheable.
- `GET /qr/:code.svg` returns an SVG QR code of `<origin>/?room=<CODE>`.
- Everything else is served from `public/` with `Cache-Control: no-cache`.

```ts
type RoleId = 'villager' | 'seer' | 'apprentice' | 'doctor' | 'witch' | 'hunter' | 'cupid' | 'elder'
  | 'prince' | 'mason' | 'lycan' | 'werewolf' | 'shadowwolf' | 'wolfcub' | 'minion' | 'sorceress' | 'jester';
// Display order is the order above.

type RoleInfo = {
  id: RoleId;
  name: string;            // "Apprentice Seer"
  team: 'village' | 'wolves' | 'solo';
  value: number;           // balance value, e.g. 7 or -6
  max: number;             // per-game limit (villager 30, werewolf 6, mason 3, others 1)
  minIfAny?: number;       // mason: 2 (0, 2 or 3 allowed)
  killer: boolean;         // werewolf, shadowwolf, wolfcub
  acts: string;            // "Every night", "Night 1", "When they die", "No"
  summary: string;         // one sentence for tiles and lists
  rules: string;           // full rules text from PLAN.md section 4
  icon: string;            // emoji fallback; the client may draw its own icon per id
};
```

## Client to server events

| Event | Payload | Who | Ack extra |
| --- | --- | --- | --- |
| `room:create` | `{ name }` | Anyone | `{ code, playerId, token }` |
| `room:join` | `{ code, name }` | Anyone | `{ code, playerId, token }` |
| `room:resume` | `{ code, playerId, token }` | Anyone | none |
| `room:reclaim` | `{ code, name }` | Anyone | `{ requestId }`, then later a `reclaim:result` event |
| `room:leave` | `{}` | Seated player | none |
| `lobby:ready` | `{ ready: boolean }` | Seated player, lobby | none |
| `lobby:settings` | `{ patch: Partial<Settings> }` | Host, lobby | none |
| `lobby:shuffle` | `{}` | Host, lobby, auto mode | none |
| `lobby:kick` | `{ playerId }` | Host, lobby | none |
| `host:transfer` | `{ playerId }` | Host | none |
| `host:approve-reclaim` | `{ requestId, allow: boolean }` | Host | none |
| `game:seen-role` | `{}` | Reveal phase | none |
| `game:night-action` | depends on task kind, below | Night | `{ result? }` |
| `game:vote` | `{ target: playerId \| 'skip' }` | Day, vote stage | none |
| `game:shoot` | `{ target }` | The Hunter, shot stage | none |
| `host:advance` | `{ action: HostAction }` | Host | none |
| `host:end-game` | `{}` | Host, in a game | none |
| `host:play-again` | `{}` | Host, game over | none |

Night action payloads:

| Task kind | Payload | Rules |
| --- | --- | --- |
| `cupid` | `{ targets: [a, b] }` | Two different living players; Cupid may include themself |
| `wolf` | `{ target }` | Pick for the current slot; send again to change; done when the pack locks |
| `meet` | `{}` | Night 1 when `firstNightKill` is off; the pack just confirms |
| `seer` | `{ target }` | Ack and `task.result` carry `{ target, wolf: boolean, text }` |
| `doctor` | `{ target }` | Not last night's protected player |
| `witch` | `{ heal: id \| null, poison: id \| null }` | Only once `task.witch.waiting` is false; heal must be a listed victim; poison anyone alive but herself |
| `sorceress` | `{ target }` | Ack and `task.result` carry `{ target, seer: boolean, text }` |
| `decoy` | `{ target }` | Any other living player |
| `ghost` | `{ target }` | Dead players; optional; any living player |

## Server to client events

| Event | Payload |
| --- | --- |
| `state` | `Snapshot` |
| `seat:invalid` | `{}` |
| `kicked` | `{ reason: string }` |
| `reclaim:result` | `{ ok: true, code, playerId, token }` or `{ ok: false, reason: string }` |
| `server:shutdown` | `{ message: string }` |

## Snapshot

```ts
type Snapshot = {
  serverNow: number;                       // server clock in ms; clients keep an offset for countdowns
  room: {
    code: string;
    you: string;                           // your player id
    hostId: string;
    isHost: boolean;
    players: { id: string; name: string; connected: boolean; left: boolean; ready: boolean;
               isHost: boolean; inGame: boolean }[];   // join order
    settings: Settings;
    deck: {                                // the line-up the next game will deal
      roles: Partial<Record<RoleId, number>>;
      score: number;                       // sum of role values
      band: 'wolves' | 'balanced' | 'village';   // -2 or below / -1..+3 / +4 or above
      target: [number, number];            // auto mode's target range after tilt and reveal shift
      inRange: boolean;
      suggestions: RoleId[];               // roles to allow when no deck fits; else []
      errors: string[];                    // hard-rule problems, e.g. "Add 2 more roles"; [] when valid
    };
    start: { ok: boolean; reason: string | null };   // reason the game can't start yet, for the status line
    countdownEndsAt: number | null;        // lobby 5 s countdown
    reclaims: { requestId: string; name: string }[]; // filled only for the host
  };
  game: Game | null;                       // null in the lobby
};

type Settings = {
  roleMode: 'auto' | 'manual';             // default 'auto'
  allowedRoles: RoleId[];                  // default all; 'werewolf' and 'villager' always included
  balanceTilt: 'village' | 'balanced' | 'wolves';   // default 'balanced'
  roles: Partial<Record<RoleId, number>>;  // manual counts; ignored in auto mode
  reveal: 'role' | 'day' | 'team' | 'wolf' | 'none';   // default 'role'
  firstNightKill: boolean;                 // default true
  deadSeeRoles: boolean;                   // default false
  voteStyle: 'secret' | 'live';            // default 'secret'
  discussionSeconds: number;               // 0 (host ends it) or 30..600; default 180
  voteSeconds: number;                     // 15..180; default 60
  nightSeconds: number;                    // 30..300; default 90
  nightMinSeconds: number;                 // 0..60 and <= nightSeconds; default 20
};

type Revealed =
  | { kind: 'role'; value: RoleId }
  | { kind: 'team'; value: 'village' | 'wolves' | 'solo' }
  | { kind: 'wolf'; value: boolean };      // true = was a killer wolf

type Game = {
  phase: 'reveal' | 'night' | 'day' | 'over';
  round: number;                           // 1 for night 1 and day 1
  paused: boolean;
  deadline: { endsAt: number | null; remainingMs: number | null; label: string } | null;
                                           // the countdown to show; remainingMs is set while paused
  rolesInPlay: Partial<Record<RoleId, number>>;
  players: {
    id: string; name: string; alive: boolean;
    role: RoleId | null;                   // only when this viewer may know it (PLAN.md section 5)
    revealed: Revealed | null;             // what the reveal setting shows about a dead player
    cause: 'night' | 'vote' | 'hunter' | 'heartbreak' | 'wolves' | 'poison' | null;
                                           // 'wolves' and 'poison' only at game over; before that both show as 'night'
  }[];                                     // join order
  me: null | {                             // null for someone who joined mid-game
    role: RoleId;
    team: 'village' | 'wolves' | 'solo';
    alive: boolean;
    knows: { pack: string[]; masons: string[]; wolves: string[];   // wolves = what a Minion sees
             lover: { id: string; sameTeam: boolean } | null };
    notes: { round: number; text: string }[];
    marks: Record<string, 'wolf' | 'notwolf' | 'seer' | 'notseer'>;
  };
  reveal: { seen: string[]; youSeen: boolean } | null;   // reveal phase only
  night: { task: Task | null } | null;                   // night phase only
  day: Day | null;                                       // day phase; the last day is kept at game over
  hostActions: HostAction[];                             // for the host: the actions allowed right now; [] for others
  log: { round: number; phase: 'night' | 'day'; text: string }[];          // public events
  winner: null | { team: 'village' | 'wolves' | 'lovers' | 'jester'; winners: string[]; title: string; text: string };
  history: null | { round: number; phase: 'night' | 'day'; text: string }[];   // game over only
  ghost: null | { guess: string | null; score?: { right: number; total: number } };
};

type Task = {
  kind: 'cupid' | 'wolf' | 'meet' | 'seer' | 'doctor' | 'witch' | 'sorceress' | 'decoy' | 'ghost';
  done: boolean;
  prompt: string;                          // e.g. "Choose a player to inspect"
  targets: string[];                       // legal targets right now
  choose: 1 | 2;                           // 2 for cupid
  wolf?: { slot: number; slots: number; picks: Record<string, string>; locked: string[] };
  witch?: { waiting: boolean; victims: string[]; canHeal: boolean; canPoison: boolean };
  result?: { target: string; text: string; wolf?: boolean; seer?: boolean };
  submitted?: unknown;                     // echo of your own action
};

type Day = {
  stage: 'shot' | 'discussion' | 'vote' | 'verdict';
  announcements: { kind: 'death' | 'info' | 'private'; text: string; playerId?: string }[];
  shooter: string | null;                  // the Hunter, during 'shot'
  shot: { targets: string[] } | null;      // only in the Hunter's own snapshot
  vote: null | {
    eligible: string[]; voted: string[];
    myVote: string | null;                 // player id, 'skip' or null
    blocked: string[];                     // your lover; the client shows it only while the eye button is held
    live: Record<string, string> | null;   // voter -> target, only when voteStyle is 'live'
    canVote: boolean;
  };
  verdict: null | {
    votes: Record<string, string>;         // voter -> target or 'skip'
    tally: Record<string, number>;
    outcome: 'eliminated' | 'prince' | 'tie' | 'skip' | 'none';
    eliminated: string | null;
    text: string;
  };
};

type HostAction = 'start-night' | 'start-vote' | 'end-vote' | 'skip-shot' | 'next-night' | 'pause' | 'resume' | 'extend';
```

Never in any snapshot: other players' roles beyond the visibility rules, other players' notes or marks, night actions, or any count of finished night tasks.

## Fixed timings (server)

| Timer | Length |
| --- | --- |
| Lobby countdown once everyone is ready | 5 s |
| Role reveal | 60 s, or as soon as everyone taps Got it |
| Pack plurality lock | 20 s before the night deadline |
| Witch's minimum after the pack locks | 20 s (the night deadline moves out if needed) |
| Hunter's shot | 30 s |
| Verdict, before night falls by itself | 20 s |
| Host offline before host passes on | 60 s |
| Empty room deleted after | 30 min; any room after 12 h |

## createServer (tests)

`server.js` exports `createServer(options)` and starts listening only when run directly.

```ts
createServer({
  timeScale?: number;      // divides every timer; tests use about 100
  minPlayers?: number;     // default 5, or env MIN_PLAYERS
  cleanupMs?: number;      // empty-room lifetime, default 30 min
  sweepMs?: number;        // cleanup sweep interval, default 5 min
  keepAliveMs?: number;    // default 150000; self-ping runs only when RENDER_EXTERNAL_URL is set
  rng?: () => number;      // seeded random source for tests; production uses crypto
}) => { httpServer, io, rooms, listen(port) => Promise<number>, close() => Promise<void> }
// rooms: the live room store (Map code -> room) for test inspection only.
// close(): stops the keep-alive, the sweep and every room timer, and closes io and httpServer.
```
