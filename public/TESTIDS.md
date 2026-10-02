# Test ids

Every interactive control and key region in `public/` carries a stable `data-testid`. Ids with `<playerId>`, `<roleId>` or `<value>` are filled in at render time. Player ids are the server's ids (the mocks use `p1` to `p17`).

Open any screen without a server at `/?mock=<name>`; `/?mock=list` links to all of them (each link is `mock-<name>`).

## Everywhere

| Id | What it is |
| --- | --- |
| `app` | The app root |
| `screen-<name>` | The current screen: `home`, `resuming`, `reclaim`, `lobby`, `reveal`, `night`, `day-discussion`, `day-shot`, `day-vote`, `day-verdict`, `over`, `late`, `mocks` |
| `announcer` | Polite live region for screen-reader announcements |
| `toasts`, `toast` | Toast container and each toast (errors arrive here) |
| `reconnect-banner` | "Reconnecting to the game", or "Updating the server… reconnecting" after `server:restarting` |
| `actionbar`, `actionbar-note` | Sticky bottom bar and its status line |

## Home

| Id | What it is |
| --- | --- |
| `name-input` | Your name (remembered on this device) |
| `name-error` | Error under the name field (`NAME_TAKEN`, `BAD_NAME`, empty) |
| `create-btn` | Create a room |
| `join-code` | 4-letter room code (filled from `/?room=CODE`) |
| `join-btn` | Join |
| `code-error` | Error under the code field (`NO_ROOM`, `BAD_CODE`, `ROOM_FULL`) |
| `rejoin`, `rejoin-btn` | "Rejoin FANG as Ana" card and its button (`room:resume`); after a mid-game Leave it says "You left the game. You can rejoin until it ends." |
| `notice` | Message after being kicked, `seat:invalid`, `server:shutdown`, a refused takeover or a failed rejoin |
| `home-foot` | Footer note, including "The server is updating. Trying again…" while a RETRY is pending |
| `modal-reclaim-offer` | Shown on `NAME_TAKEN_OFFLINE` |
| `reclaim-btn` | Ask the host for the seat (`room:reclaim`) |
| `reclaim-other` | Use another name instead |
| `reclaim-cancel` | Cancel while waiting for the host (screen `reclaim`) |

## Lobby

| Id | What it is |
| --- | --- |
| `room-code` | The code, letter by letter |
| `qr-btn` | QR thumbnail; opens the share sheet |
| `share-btn`, `copy-link` | Native share sheet (falls back to copy) and copy link |
| `status-line` | `room.start.reason`, or "Everyone is ready" |
| `players` | Player list |
| `player-<playerId>` | One player row (ready, host, offline, left) |
| `player-menu-<playerId>` | Host only: opens `sheet-player` |
| `make-host-<playerId>`, `kick-<playerId>` | In the player sheet |
| `ready-toggle` | I'm ready / Ready (`aria-pressed`) |
| `countdown`, `countdown-cancel` | The 5-second countdown overlay and "Wait, I'm not ready" |
| `role-setup` | Role setup panel |
| `role-mode-auto`, `role-mode-manual` | Host: line-up mode |
| `lineup` | Role chips of the current deck |
| `balance-meter` | Balance meter |
| `tilt-wolves`, `tilt-balanced`, `tilt-village` | Host, auto: balance tilt |
| `shuffle-btn` | Host, auto: deal a new line-up (`lobby:shuffle`) |
| `allowed-toggle`, `allowed-roles`, `allow-<roleId>` | Host, auto: allowed roles disclosure and switches |
| `deck-suggestions`, `deck-errors` | Roles to allow; hard-rule errors |
| `manual-roles`, `role-minus-<roleId>`, `role-plus-<roleId>`, `role-count-<roleId>` | Host, manual: counts |
| `settings` | Settings panel |
| `setting-reveal` | Reveal on death (select) |
| `setting-first-night-kill`, `setting-dead-see-roles` | Switches (`aria-checked`) |
| `setting-vote-style-secret`, `setting-vote-style-live` | Vote style |
| `setting-preset-person`, `setting-preset-call`, `setting-preset-long` | Timer presets |
| `setting-<timer>`, `setting-<timer>-minus`, `setting-<timer>-plus` | `<timer>` is `discussion`, `vote`, `night` or `night-min` |
| `modal-reclaim`, `reclaim-allow`, `reclaim-refuse` | Host's approve prompt for a seat takeover |
| `lobby-narration-toggle` | Host: narrate from this phone (the tap also unlocks speech on iOS) |

## In-game header

| Id | What it is |
| --- | --- |
| `topbar` | Header |
| `code-chip` | Room code; opens `sheet-code` |
| `phase-title` | "Night 2", "Vote", "Verdict"... |
| `timer` | Countdown (`role="timer"`) |
| `my-role-btn`, `my-role-card` | Hold to see your role, and the card it shows |
| `roles-btn` | Opens `sheet-roles` |
| `eye-btn` | Peek: a tap shows private marks and, at night, the private panel; it hides itself after 8 s. Holding shows them only while held |
| `menu-btn` | Opens `sheet-menu` |

## Role reveal

| Id | What it is |
| --- | --- |
| `role-card`, `role-card-front` | Press-and-hold card (`data-open`, `aria-pressed`) and its face |
| `got-it` | Got it (`game:seen-role`) |
| `reveal-progress` | "6 of 9 ready" |
| `host-start-night` | Host: start night 1 early |

## Night

Without Peek every living player sees the same screens: the pick grid, Confirm, then "Done. Waiting for the village". Role-specific text and the real choices live in the private panel.

| Id | What it is |
| --- | --- |
| `task`, `task-prompt` | The shared pick screen ("Pick a player, then confirm") |
| `player-grid`, `tile-<playerId>` | Tile grid and a tile (`aria-pressed` when picked, `aria-disabled` when not a legal target; it looks the same either way) |
| `confirm-btn` | Confirm (also the ghost's guess) |
| `night-done`, `big-timer` | The shared Done screen and its countdown |
| `private-open` | Opens the private panel from the Done screen (same as tapping `eye-btn`) |
| `private-panel`, `private-close` | The private panel (auto-hides after 8 s without a touch) and its close button |
| `private-result` | Seer or Sorceress answer |
| `private-status` | "Saved." or an error after a private action (not a live region) |
| `pack-picks`, `wolf-slot`, `priv-wolf-<playerId>` | Wolves: the pack's picks, "Victim 2 of 2", change your pick |
| `priv-heal-<playerId>`, `priv-poison-<playerId>`, `priv-witch-use`, `priv-witch-pass` | Witch: heal a victim, poison someone, send or pass (only once the pack has locked) |
| `priv-cupid-<playerId>`, `priv-cupid-send` | Cupid: choose the two Lovers and link them |
| `doctor-not-again`, `priv-doctor-self` | Doctor: who can't be protected again, protect yourself |
| `ghost` | Ghost screen at night |

## Day

| Id | What it is |
| --- | --- |
| `discussion`, `dawn` | Discussion screen and the dawn announcement card |
| `death-<playerId>` | One death in the dawn card |
| `news-hold` | Hold to see private news (shown to everyone) |
| `game-log` | Public log |
| `ghost-banner` | "You're a ghost. Stay silent." |
| `shot-hunter`, `shoot-btn` | The Hunter's screen and Shoot button |
| `shot-wait` | "The Hunter takes aim" for everyone else |
| `vote`, `vote-waiting`, `vote-count` | Vote screen, "Waiting for: ..." and "5 of 7 voted" |
| `vote-skip` | Skip (`aria-pressed`); tiles vote directly |
| `tie-rule` | "A tie, or Skip on top, means nobody is eliminated." |
| `verdict`, `verdict-text`, `ballots`, `ballot-<playerId or skip>` | Verdict screen (`data-outcome`), result and every vote |
| `host-controls` | Host control group |
| `host-start-vote`, `host-end-vote`, `host-skip-shot`, `host-next-night`, `host-pause`, `host-resume`, `host-extend` | One per `game.hostActions` entry; each opens a confirm |
| `modal-confirm`, `dialog-confirm`, `dialog-cancel` | The confirm dialog and its buttons |
| `death-moment`, `death-ok` | Full-screen death moment and "Continue as a ghost" |

## Game over

| Id | What it is |
| --- | --- |
| `game-over`, `winner-banner`, `you-result` | Screen, winning team, "You won" |
| `ghost-score` | Ghost guesses scored |
| `cast`, `cast-<playerId>` | Every role revealed |
| `recap` | Night-by-night history |
| `play-again`, `change-setup` | Host: back to the lobby (both send `host:play-again`) |

## Sheets and menu

| Id | What it is |
| --- | --- |
| `sheet-<kind>` | `code`, `roles`, `menu`, `guide`, `player`, `transfer` |
| `sheet-close`, `sheet-scrim` | Close button and backdrop |
| `sheet-code`, `join-link`, `sheet-share`, `sheet-copy` | Share sheet contents |
| `menu-code`, `guide-btn` | Menu: show code and QR, role guide |
| `narration-toggle`, `sound-toggle`, `haptics-toggle` | This phone's narration, sounds and vibration |
| `transfer-btn`, `transfer-<playerId>` | Host: hand host to a connected player |
| `host-end-game` | Host: end the game (confirm first) |
| `leave-btn` | Leave the room (confirm first) |
| `late` | Screen for someone who joined mid-game |
