# Engine API (`src/game.js`)

The rules engine is pure: plain-JSON state in, mutated plain-JSON state out, no sockets, no real timers, no global randomness. `src/rooms.js` and `server.js` call it; PLAN.md section 5 is the rules contract and docs/PROTOCOL.md defines the `game` snapshot that `viewFor` returns.

```js
const G = require('./src/game');
```

## Errors

`G.GameError extends Error` with a `code` from PROTOCOL.md (`NOT_ALLOWED`, `BAD_TARGET`, `BAD_REQUEST`, `BAD_SETTINGS`). Every mutator throws it for illegal input and leaves state unchanged.

## Creating a game

```js
const state = G.createGame({
  players: [{ id, name }],        // join order = seating order
  roles: { werewolf: 2, seer: 1, villager: 5 },   // must pass roles.validateDeck(roles, players.length)
  settings,                        // PROTOCOL.md Settings (reveal, firstNightKill, deadSeeRoles, voteStyle, timers)
  now,                             // ms
  rng = Math.random,               // dealing and tie-breaks; tests pass a seeded one
  timeScale = 1,                   // every timer is divided by this
});
// state.phase === 'reveal'; JSON.stringify(state) round-trips (no Map, Set, class instances or functions).
```

## Mutators

All take `now` (ms), mutate `state` in place, and may advance the phase.

| Function | Use |
| --- | --- |
| `G.seenRole(state, playerId, now)` | Reveal phase "Got it" |
| `G.nightAction(state, playerId, payload, now)` | Returns `{ result }` for Seer and Sorceress checks, else `{}` |
| `G.vote(state, playerId, target, now)` | `target` is a player id or `'skip'` |
| `G.shoot(state, playerId, target, now)` | The dead Hunter's shot |
| `G.hostAction(state, action, now, ctx)` | `action` is a PROTOCOL `HostAction`; `ctx.isOnline(playerId)` decides whether `skip-shot` is allowed |
| `G.onDeadline(state, now)` | Handles every deadline at or before `now` (night minimum, pack auto-lock, night end, reveal, discussion, vote, shot, verdict) |

## Queries

| Function | Returns |
| --- | --- |
| `G.nextDeadline(state)` | The earliest pending deadline in ms, or `null` (none, paused, or game over). The server keeps one `setTimeout` for it and then calls `onDeadline` |
| `G.viewFor(state, playerId, ctx)` | The PROTOCOL `Game` object for that viewer. `ctx = { isHost, isOnline }`; `isHost` adds `hostActions` and hides the dead players' full view from a dead host; `isOnline(id)` decides whether `skip-shot` is offered. A `playerId` not in the game gets the public view with `me: null` |
| `G.inGame(state, playerId)` | Whether that player was dealt into this game |
| `G.isOver(state)` | `state.phase === 'over'` |
| `G.trueRoles(state)` | `{ [playerId]: roleId }` for everyone dealt in. Server-side only (the bot simulation's visibility oracle, logging); never send it to a client |
| `G.aliveIds(state)` | The living player ids, in join order |

`G.DEFAULT_SETTINGS` holds the engine's defaults for the game-relevant settings; `createGame` fills any missing ones from it and ignores lobby-only keys.

## Timers

`G.TIMERS` holds the fixed lengths in ms before `timeScale`: `revealMs 60000`, `shotMs 30000`, `verdictMs 20000`, `packLockLeadMs 20000`, `witchMinMs 20000`, `extendMs 30000`. Setting-driven timers (`nightSeconds`, `nightMinSeconds`, `discussionSeconds`, `voteSeconds`) are also divided by `timeScale`.

## Shared helpers from `src/roles.js` (already written)

`ROLES`, `ROLE_IDS`, `ROLE_BY_ID`, `isRole`, `teamOf`, `isKiller`, `seerSeesWolf`, `scoreDeck`, `bandOf`, `targetRange`, `killerCount`, `validateDeck(roles, playerCount)`, `buildAutoDeck({ playerCount, allowedRoles, tilt, reveal, rng })`, `roleInfoList()`, `shuffled(rng, list)`, `MIN_PLAYERS`, `MAX_PLAYERS`.

## Test-only options

`createGame({ ..., assign: { ana: 'werewolf', ben: 'seer' } })` gives those players those roles before the rest of the deck is shuffled and dealt to everyone else. Each assigned role must still be in `roles` (with enough copies) or `createGame` throws `BAD_SETTINGS`; an unknown player id throws `BAD_REQUEST`. Production code never passes it; `test/game.test.js` builds every fixed-role game with it.

## Rulings where PLAN.md is silent

- **Randomness.** Dealing uses the `rng` passed in. Every later random choice (the pack's plurality tie-break, the order of dawn deaths) comes from a PRNG whose state is `state.rngState`, seeded once from `rng`, so state stays JSON and a replay is deterministic.
- **Pause** freezes the current stage's timers only. Players can still act, and changes that don't depend on time still happen (everyone voted, everyone tapped Got it, the last night task once the night minimum had already passed). Any phase or stage change clears the pause and starts fresh timers. `resume` shifts every pending deadline by the paused time.
- **Night tasks are final once submitted**, ghost guesses included. Only pack picks can change, until the pack locks.
- **Pack lock.** `task.wolf.slot` is 1-based (1 to `slots`). The forced lock takes the plurality of the current slot; on a two-victim night, a slot nobody picked for stays empty. If no wolf has a legal victim left for the second slot, the pack finishes with one. If the server wakes late, the forced lock happens at `now` and the Witch still gets her 20 s from then.
- **Witch.** `task.targets` are her poison targets; heal targets are `task.witch.victims`. `canHeal` is false when the heal is spent or there is no victim tonight. A heal and poison on the same player: the heal saves them from the pack, the poison still kills.
- **Deaths.** A player killed by the pack and poisoned in the same night dies once, cause `wolves`. A Doctor-protected or healed Elder keeps the extra life (both come before the Elder in the resolution order).
- **Prince.** The verdict has `outcome: 'prince'` and `eliminated: null`; the Prince's role becomes public in `players[].role`.
- **Hunter.** After a shot at dawn, play goes to discussion; after a shot during a verdict, play returns to the verdict stage and its 20 s timer starts then. The Hunter's role becomes public only once they shoot (`day.shooter` names them during the shot stage either way).
- **Game over.** Every dead player's `revealed` becomes `{ kind: 'role' }` and `cause` shows the true `wolves` or `poison`. A ghost guess scores when the guessed player was one of the pack's locked victims that night, whether or not they died.
- **Round** is 1 from the role reveal through night 1 and day 1; `next-night` starts round + 1.
