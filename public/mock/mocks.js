// Sample snapshots for every screen and state, shaped exactly like docs/PROTOCOL.md.
// app.js loads this module only for `?mock=<name>` and `?mock=list`; no server is involved.
// Role names, teams and rules come from mock/roles.json, the bundled copy of the catalog.

const CAST = [
  ['p1', 'Meera'], ['p2', 'Kabir'], ['p3', 'Zoya'], ['p4', 'Ishaan'], ['p5', 'Tara'],
  ['p6', 'Rohan'], ['p7', 'Nisha'], ['p8', 'Siddharth Menon'], ['p9', 'Dev'],
];
const EXTRA = [
  ['p10', 'Priya'], ['p11', 'Arjun'], ['p12', 'Sana'], ['p13', 'Vikram'], ['p14', 'Leela'],
  ['p15', 'Omar'], ['p16', 'Farah'], ['p17', 'Anantharaman'],
];
// Who holds what in the sample game (host is Meera, p1).
const DEAL = { p1: 'villager', p2: 'werewolf', p3: 'seer', p4: 'doctor', p5: 'witch', p6: 'werewolf', p7: 'hunter', p8: 'cupid', p9: 'villager' };
const IN_PLAY = { villager: 2, seer: 1, doctor: 1, witch: 1, hunter: 1, cupid: 1, werewolf: 2 };
const ALL_ROLES = ['villager', 'seer', 'apprentice', 'doctor', 'witch', 'hunter', 'cupid', 'elder', 'prince',
  'mason', 'lycan', 'werewolf', 'shadowwolf', 'wolfcub', 'minion', 'sorceress', 'jester'];

const SETTINGS = {
  roleMode: 'auto', allowedRoles: ALL_ROLES.slice(), balanceTilt: 'balanced', roles: {}, reveal: 'role',
  firstNightKill: true, deadSeeRoles: false, voteStyle: 'secret',
  discussionSeconds: 180, voteSeconds: 60, nightSeconds: 90, nightMinSeconds: 20,
};
const DECK = {
  roles: { werewolf: 2, seer: 1, witch: 1, hunter: 1, sorceress: 1, villager: 3 },
  score: 2, band: 'balanced', target: [-1, 3], inRange: true, suggestions: [], errors: [],
};

const LOG = [
  { round: 1, phase: 'night', text: 'Dev was found dead.' },
  { round: 1, phase: 'day', text: 'Rohan was voted out with 5 votes. Rohan was a Werewolf.' },
  { round: 2, phase: 'night', text: 'Nobody died in the night.' },
];
const HISTORY = [
  { round: 1, phase: 'night', text: 'Cupid (Siddharth Menon) linked Zoya and Tara as Lovers.' },
  { round: 1, phase: 'night', text: 'The pack (Kabir, Rohan) chose Dev.' },
  { round: 1, phase: 'night', text: 'The Doctor (Ishaan) protected Kabir.' },
  { round: 1, phase: 'night', text: 'The Seer (Zoya) checked Rohan: a werewolf.' },
  { round: 1, phase: 'night', text: 'The Witch (Tara) kept both potions.' },
  { round: 1, phase: 'day', text: 'Rohan was voted out with 5 votes.' },
  { round: 2, phase: 'night', text: 'Kabir chose Ishaan. The Doctor (Ishaan) protected himself, so nobody died.' },
  { round: 2, phase: 'night', text: 'The Seer (Zoya) checked Kabir: a werewolf.' },
  { round: 2, phase: 'day', text: 'Kabir was voted out with 6 votes. The village wins.' },
];

function makeContext({ roles = {}, now = Date.now() } = {}) {
  const teamOf = (id) => roles[id]?.team || (['werewolf', 'shadowwolf', 'wolfcub', 'minion', 'sorceress'].includes(id) ? 'wolves' : id === 'jester' ? 'solo' : 'village');
  const T = (sec) => now + sec * 1000;
  const deadline = (sec, label) => ({ endsAt: T(sec), remainingMs: null, label });

  // Lobby room. `you` picks the viewer; `extra` adds players; `over` patches individual players.
  function room({ you = 'p1', count = 9, ready = [], offline = [], extra = 0, over = {}, settings = {}, deck = {}, start, countdown = null, reclaims = [], left = [] } = {}) {
    const list = CAST.concat(EXTRA.slice(0, extra)).slice(0, count + extra);
    const players = list.map(([id, name]) => ({
      id, name, connected: !offline.includes(id), left: left.includes(id), ready: ready === 'all' ? true : ready.includes(id),
      isHost: id === 'p1', inGame: true, ...(over[id] || {}),
    }));
    const notReady = players.filter((p) => !p.ready && !p.left).length;
    return {
      code: 'FANG', you, hostId: 'p1', isHost: you === 'p1', players,
      settings: { ...SETTINGS, ...settings },
      deck: { ...DECK, ...deck },
      start: start || (notReady ? { ok: false, reason: `Waiting for ${notReady} player${notReady === 1 ? '' : 's'} to get ready` } : { ok: true, reason: null }),
      countdownEndsAt: countdown,
      reclaims: you === 'p1' ? reclaims : [],
    };
  }

  const snap = (r, g = null) => ({ serverNow: now, room: r, game: g });

  // A game snapshot from one viewer's seat. `dead` maps ids to { cause, revealed }.
  function game({ you = 'p3', phase = 'night', round = 1, deal = DEAL, dead = {}, known = {}, knows = {}, notes = [], marks = {},
    hostActions = [], night = null, day = null, reveal = null, deadline: dl = null, paused = false, winner = null,
    history = null, ghost = null, log = LOG.filter((e) => e.round < round || (e.round === round && phase !== 'night' && e.phase === 'night')), rolesInPlay = IN_PLAY } = {}) {
    const ids = Object.keys(deal);
    const players = CAST.filter(([id]) => ids.includes(id)).map(([id, name]) => {
      const d = dead[id];
      const role = phase === 'over' ? deal[id] : id === you ? deal[id] : known[id] || (d && d.revealed?.kind === 'role' ? d.revealed.value : null);
      return { id, name, alive: !d, role, revealed: d ? d.revealed ?? null : null, cause: d ? d.cause : null };
    });
    const me = you && deal[you] ? {
      role: deal[you], team: teamOf(deal[you]), alive: !dead[you],
      knows: { pack: [], masons: [], wolves: [], lover: null, ...knows }, notes, marks,
    } : null;
    return { phase, round, paused, deadline: dl, rolesInPlay, players, me, reveal, night, day, hostActions, log, winner, history, ghost };
  }

  const alive = (deal, dead = {}) => Object.keys(deal).filter((id) => !dead[id]);
  const others = (you, deal, dead = {}) => alive(deal, dead).filter((id) => id !== you);
  const wolfPack = { pack: ['p2', 'p6'] };
  const ingame = (o = {}) => room({ ready: 'all', start: { ok: true, reason: null }, ...o });
  const nightTask = (task) => ({ task: { done: false, choose: 1, ...task } });
  const deadDev = { p9: { cause: 'night', revealed: { kind: 'role', value: 'villager' } } };
  const deadRohan = { ...deadDev, p6: { cause: 'vote', revealed: { kind: 'role', value: 'werewolf' } } };

  const M = {};
  const add = (name, group, title, def) => { M[name] = { group, title, ...def }; };

  /* Home */
  add('home', 'Home', 'Home, first visit', { snap: null, ui: { home: { name: '', code: '', errors: {} } } });
  add('home-filled', 'Home', 'Name remembered', { snap: null, ui: { home: { name: 'Meera', code: '', errors: {} } } });
  add('home-link', 'Home', 'Opened from a link', { snap: null, ui: { home: { name: 'Meera', code: 'FANG', errors: {} } } });
  add('home-rejoin', 'Home', 'Rejoin offer', { snap: null, seat: { code: 'FANG', playerId: 'p1', token: 'x', name: 'Meera' }, ui: { home: { name: 'Meera', code: '', errors: {} } } });
  add('home-no-room', 'Home', 'Error: no room', { snap: null, ui: { home: { name: 'Meera', code: 'FANK', errors: { code: 'No room called FANK' } } } });
  add('home-name-taken', 'Home', 'Error: name taken', { snap: null, ui: { home: { name: 'Zoya', code: 'FANG', errors: { name: 'That name is taken in this room' } } } });
  add('home-full', 'Home', 'Error: room full', { snap: null, ui: { home: { name: 'Meera', code: 'FANG', errors: { code: 'This room is full' } } } });
  add('home-reclaim', 'Home', 'Name held by an offline seat', { snap: null, ui: { home: { name: 'Dev', code: 'FANG', errors: {} }, reclaim: { stage: 'offer', code: 'FANG', name: 'Dev' } } });
  add('reclaim-waiting', 'Home', 'Waiting for the host to approve', { snap: null, ui: { reclaim: { stage: 'waiting', code: 'FANG', name: 'Dev', requestId: 'r1' } } });
  add('kicked', 'Home', 'Kicked by the host', { snap: null, ui: { notice: { title: 'You were removed from the room', text: 'The host removed you from FANG. You can join again with the code.' } } });
  add('seat-invalid', 'Home', 'Saved seat no longer valid', { snap: null, ui: { notice: { title: 'That game has ended', text: 'Your saved seat is no longer in a room. Create a room or join one with its code.' } } });
  add('server-shutdown', 'Home', 'Server restarting', { snap: null, ui: { notice: { title: 'The server is restarting', text: 'The server is restarting; this game has ended. Create a new room in a minute.' } } });
  add('resuming', 'Home', 'Rejoining a saved seat', { snap: null, seat: { code: 'FANG', playerId: 'p1', token: 'x', name: 'Meera' }, ui: { resuming: true } });

  return { M, add, room, game, snap, ingame, nightTask, alive, others, wolfPack, deadDev, deadRohan, deadline, T, teamOf };
}

/* Lobby */
function defineLobby({ add, room, snap, T }) {
  add('lobby-host', 'Lobby', 'Host, auto line-up', { snap: snap(room({ ready: ['p2', 'p3', 'p5', 'p7', 'p9'], offline: ['p8'] })) });
  add('lobby-host-allowed', 'Lobby', 'Host, allowed roles open', {
    snap: snap(room({ ready: ['p2', 'p3'], settings: { allowedRoles: ['villager', 'werewolf', 'seer', 'hunter', 'cupid', 'lycan', 'wolfcub', 'minion'], balanceTilt: 'village' },
      deck: { roles: { werewolf: 2, seer: 1, hunter: 1, cupid: 1, villager: 4 }, score: 0, band: 'balanced', target: [4, 7], inRange: false, suggestions: ['doctor', 'witch', 'elder'] } })),
    ui: { expanded: { allowed: true } },
  });
  add('lobby-host-manual', 'Lobby', 'Host, manual counts', {
    snap: snap(room({ ready: [], settings: { roleMode: 'manual', roles: { werewolf: 2, seer: 1, doctor: 1, mason: 2, villager: 2 } },
      deck: { roles: { werewolf: 2, seer: 1, doctor: 1, mason: 2, villager: 2 }, score: 4, band: 'village', inRange: true, errors: ['Add 1 more role'] },
      start: { ok: false, reason: 'Roles add up to 8 but there are 9 players' } })),
  });
  add('lobby-guest', 'Lobby', 'Guest, read-only setup', {
    snap: snap(room({ you: 'p4', ready: ['p1', 'p2', 'p3'], offline: ['p6'], over: { p9: { name: '<i>Kai</i>&"x' } } })),
  });
  add('lobby-guest-ready', 'Lobby', 'Guest, ready', { snap: snap(room({ you: 'p4', ready: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'], settings: { voteStyle: 'live', reveal: 'team', discussionSeconds: 0 } })) });
  add('lobby-few', 'Lobby', 'Not enough players', { snap: snap(room({ count: 3, ready: ['p1', 'p2'], deck: { roles: { werewolf: 1, villager: 2 }, score: -4, band: 'wolves', inRange: false }, start: { ok: false, reason: 'Need at least 5 players' } })) });
  add('lobby-countdown', 'Lobby', '5-second countdown', { snap: snap(room({ you: 'p4', ready: 'all', start: { ok: true, reason: null }, countdown: T(4.2) })) });
  add('lobby-big', 'Lobby', '17 players, long-game warning', { snap: snap(room({ extra: 8, ready: ['p1', 'p3', 'p4', 'p10', 'p11'], deck: { roles: { werewolf: 3, wolfcub: 1, seer: 1, apprentice: 1, doctor: 1, witch: 1, hunter: 1, mason: 2, jester: 1, villager: 5 }, score: 2 } })) });
  add('lobby-reclaim-prompt', 'Lobby', 'Host approves a seat takeover', { snap: snap(room({ ready: ['p2', 'p3'], offline: ['p9'], reclaims: [{ requestId: 'r1', name: 'Dev' }] })) });
  add('lobby-qr', 'Lobby', 'Share sheet with QR', { snap: snap(room({ ready: ['p2'] })), ui: { sheet: 'code' } });
  add('lobby-player-sheet', 'Lobby', 'Host: kick or make host', { snap: snap(room({ ready: ['p2'] })), ui: { sheet: 'player:p6' } });
  add('lobby-kick-confirm', 'Lobby', 'Host: confirm a kick', { snap: snap(room({ ready: ['p2'] })), ui: { dialog: { title: 'Remove Rohan?', text: 'They go back to the home screen and can join again with the code.', yes: 'Remove', tone: 'danger' } } });
  add('lobby-menu', 'Lobby', 'Menu with narration', { snap: snap(room({ ready: ['p2'] })), ui: { sheet: 'menu' } });
}

/* Role reveal */
function defineReveal({ add, game, snap, ingame, deadline, wolfPack }) {
  const rv = (seen, youSeen) => ({ seen, youSeen });
  add('reveal', 'Role reveal', 'Card face down', { snap: snap(ingame({ you: 'p3' }), game({ you: 'p3', phase: 'reveal', reveal: rv(['p1', 'p2'], false), deadline: deadline(52, 'Night 1 starts') })) });
  add('reveal-open', 'Role reveal', 'Card held: Seer', { snap: snap(ingame({ you: 'p3' }), game({ you: 'p3', phase: 'reveal', reveal: rv(['p1', 'p2'], false), deadline: deadline(47, 'Night 1 starts') })), ui: { sticky: { card: true } } });
  add('reveal-wolf', 'Role reveal', 'Card held: Werewolf and pack', { snap: snap(ingame({ you: 'p2' }), game({ you: 'p2', phase: 'reveal', known: { p6: 'werewolf' }, knows: wolfPack, reveal: rv(['p1'], false), deadline: deadline(44, 'Night 1 starts') })), ui: { sticky: { card: true } } });
  add('reveal-minion', 'Role reveal', 'Card held: Minion', {
    snap: snap(ingame({ you: 'p9' }), game({ you: 'p9', phase: 'reveal', deal: { ...DEAL, p9: 'minion' }, knows: { wolves: ['p2', 'p6'] }, reveal: rv([], false), deadline: deadline(50, 'Night 1 starts') })),
    ui: { sticky: { card: true } },
  });
  add('reveal-seen', 'Role reveal', 'Got it, 6 of 9 ready', { snap: snap(ingame({ you: 'p3' }), game({ you: 'p3', phase: 'reveal', reveal: rv(['p1', 'p2', 'p3', 'p5', 'p6', 'p8'], true), deadline: deadline(31, 'Night 1 starts') })) });
  add('reveal-host', 'Role reveal', 'Host can start night 1 early', { snap: snap(ingame({ you: 'p1' }), game({ you: 'p1', phase: 'reveal', reveal: rv(['p1', 'p2', 'p3', 'p5'], true), hostActions: ['start-night'], deadline: deadline(38, 'Night 1 starts') })) });
}

/* Night */
function defineNight({ add, game, snap, ingame, nightTask, others, alive, wolfPack, deadDev, deadRohan, deadline }) {
  const night = (you, task, extra = {}) => snap(ingame({ you }), game({ you, phase: 'night', round: extra.round || 1, night: nightTask(task), deadline: deadline(extra.left ?? 71, 'Night ends'), ...extra }));
  const killTargets = (dead = {}) => alive(DEAL, dead).filter((id) => !['p2', 'p6'].includes(id));

  add('night-cupid', 'Night', 'Cupid links two lovers', { snap: night('p8', { kind: 'cupid', prompt: 'Choose two players to fall in love', targets: alive(DEAL), choose: 2 }), ui: { pick: ['p3', 'p5'] } });
  add('night-wolf', 'Night', 'Werewolf picks a victim', {
    snap: night('p2', { kind: 'wolf', prompt: 'Choose the pack’s victim', targets: killTargets(), wolf: { slot: 1, slots: 1, picks: { p2: 'p4', p6: 'p7' }, locked: [] }, submitted: { target: 'p4' } }, { known: { p6: 'werewolf' }, knows: wolfPack }),
  });
  add('night-wolf-peek', 'Night', 'Werewolf holds Peek: pack picks', {
    snap: night('p2', { kind: 'wolf', prompt: 'Choose the pack’s victim', targets: killTargets(), wolf: { slot: 1, slots: 1, picks: { p2: 'p4', p6: 'p7' }, locked: [] }, submitted: { target: 'p4' } }, { known: { p6: 'werewolf' }, knows: wolfPack }),
    ui: { sticky: { eye: true } },
  });
  add('night-wolf-two', 'Night', 'Wolf Cub bonus: second victim', {
    snap: night('p2', { kind: 'wolf', prompt: 'Choose a second victim', targets: killTargets(deadDev).filter((id) => id !== 'p4'), wolf: { slot: 2, slots: 2, picks: { p2: 'p5' }, locked: ['p4'] } },
      { round: 2, dead: deadDev, known: { p6: 'werewolf' }, knows: wolfPack }),
    ui: { sticky: { eye: true } },
  });
  add('night-meet', 'Night', 'No kill on night 1: the pack meets', {
    snap: night('p6', { kind: 'meet', prompt: 'Meet your pack', targets: [] }, { known: { p2: 'werewolf' }, knows: wolfPack }),
    ui: { sticky: { eye: true } },
  });
  add('night-seer', 'Night', 'Seer chooses who to inspect', { snap: night('p3', { kind: 'seer', prompt: 'Choose a player to inspect', targets: others('p3', DEAL) }), ui: { pick: ['p6'] } });
  const seerDone = { kind: 'seer', done: true, prompt: 'Choose a player to inspect', targets: [], submitted: { target: 'p6' }, result: { target: 'p6', wolf: true, text: 'Rohan is a werewolf' } };
  add('night-seer-done', 'Night', 'Seer done, answer hidden', { snap: night('p3', seerDone, { marks: { p6: 'wolf' } }) });
  add('night-seer-result', 'Night', 'Seer holds the answer', { snap: night('p3', seerDone, { marks: { p6: 'wolf' } }), ui: { sticky: { secret: true } } });
  add('night-sorceress-result', 'Night', 'Sorceress holds the answer', {
    snap: night('p9', { kind: 'sorceress', done: true, prompt: 'Choose a player to search', targets: [], submitted: { target: 'p3' }, result: { target: 'p3', seer: true, text: 'Zoya is the Seer' } },
      { deal: { ...DEAL, p9: 'sorceress' }, marks: { p3: 'seer' } }),
    ui: { sticky: { secret: true } },
  });
  add('night-doctor', 'Night', 'Doctor protects someone', {
    snap: night('p4', { kind: 'doctor', prompt: 'Choose a player to protect tonight', targets: alive(DEAL, deadRohan).filter((id) => id !== 'p7') }, { round: 2, dead: deadRohan, left: 64 }),
    ui: { pick: ['p4'] },
  });
  add('night-witch-waiting', 'Night', 'Witch waits for the pack', {
    snap: night('p5', { kind: 'witch', prompt: 'Wait while the pack chooses', targets: [], witch: { waiting: true, victims: [], canHeal: true, canPoison: true } }, { left: 58 }),
  });
  const witchTask = { kind: 'witch', prompt: 'Use your potions', targets: others('p5', DEAL), witch: { waiting: false, victims: ['p9'], canHeal: true, canPoison: true } };
  add('night-witch', 'Night', 'Witch chooses potions', { snap: night('p5', witchTask, { left: 33 }), ui: { witch: { heal: 'p9', poison: null } } });
  add('night-witch-peek', 'Night', 'Witch holds Peek: the victim', { snap: night('p5', witchTask, { left: 29 }), ui: { sticky: { eye: true }, witchMode: 'poison', witch: { heal: 'p9', poison: 'p6' } } });
  add('night-decoy', 'Night', 'Villager: who do you suspect?', { snap: night('p9', { kind: 'decoy', prompt: 'Who do you suspect?', targets: others('p9', DEAL) }), ui: { pick: ['p2'] } });
  add('night-done', 'Night', 'Done. Waiting for the village', { snap: night('p9', { kind: 'decoy', done: true, prompt: 'Who do you suspect?', targets: [], submitted: { target: 'p2' } }, { left: 48 }) });
  add('night-peek-marks', 'Night', 'Seer task with marks held', {
    snap: night('p3', { kind: 'seer', prompt: 'Choose a player to inspect', targets: others('p3', DEAL, deadRohan).filter((id) => id !== 'p4') }, { round: 2, dead: deadRohan, marks: { p6: 'wolf', p4: 'notwolf' }, knows: { lover: { id: 'p5', sameTeam: true } } }),
    ui: { sticky: { eye: true } },
  });
  add('night-ghost', 'Night', 'Ghost guesses the victim', {
    snap: snap(ingame({ you: 'p9' }), game({ you: 'p9', phase: 'night', round: 2, dead: deadDev, night: nightTask({ kind: 'ghost', prompt: 'Who will the wolves take tonight?', targets: alive(DEAL, deadDev) }), ghost: { guess: 'p4' }, deadline: deadline(66, 'Night ends') })),
  });
  add('night-my-role', 'Night', 'Holding My role', { snap: night('p3', { kind: 'seer', prompt: 'Choose a player to inspect', targets: others('p3', DEAL) }, { notes: [] }), ui: { sticky: { myrole: true } } });
}

/* Day: dawn, discussion, Hunter, vote, verdict */
function defineDay({ add, game, snap, ingame, alive, others, deadDev, deadRohan, deadline }) {
  const dawnDev = [{ kind: 'death', playerId: 'p9', text: 'Dev was found dead.' }];
  const day = (you, stage, extra = {}) => {
    const { dead = deadDev, round = 2, left = 154, label = 'Voting starts', host, dayx = {}, ...rest } = extra;
    return snap(ingame({ you }), game({
      you, phase: 'day', round, dead, deadline: left == null ? null : deadline(left, label),
      day: { stage, announcements: dawnDev, shooter: null, shot: null, vote: null, verdict: null, ...dayx },
      hostActions: host || [], ...rest,
    }));
  };

  add('dawn', 'Dawn and discussion', 'Dawn: one death with role', { snap: day('p3', 'discussion', { round: 1, left: 171 }) });
  add('dawn-heartbreak', 'Dawn and discussion', 'Dawn: lovers, team reveal', {
    snap: day('p3', 'discussion', {
      round: 2, left: 168,
      dead: { ...deadDev, p4: { cause: 'night', revealed: { kind: 'team', value: 'village' } }, p8: { cause: 'heartbreak', revealed: { kind: 'team', value: 'village' } } },
      dayx: { announcements: [
        { kind: 'death', playerId: 'p4', text: 'Ishaan was found dead.' },
        { kind: 'death', playerId: 'p8', text: 'Siddharth Menon died of a broken heart.' },
      ] },
    }),
  });
  add('dawn-quiet', 'Dawn and discussion', 'Dawn: nobody died', { snap: day('p3', 'discussion', { round: 2, dead: deadRohan, dayx: { announcements: [] } }) });
  add('dawn-news', 'Dawn and discussion', 'Private news held', {
    snap: day('p3', 'discussion', { round: 1, knows: { lover: { id: 'p5', sameTeam: true } },
      dayx: { announcements: [...dawnDev, { kind: 'private', text: 'Cupid linked you with Tara. You are on the same team.' }] } }),
    ui: { sticky: { news: true } },
  });
  add('discussion-host', 'Dawn and discussion', 'Host: start vote, pause, +30 s', { snap: day('p1', 'discussion', { dead: deadRohan, host: ['start-vote', 'pause', 'extend'] }) });
  add('discussion-paused', 'Dawn and discussion', 'Timer paused', {
    snap: (() => { const s = day('p3', 'discussion', { dead: deadRohan }); s.game.paused = true; s.game.deadline = { endsAt: null, remainingMs: 97000, label: 'Voting starts' }; return s; })(),
  });
  add('discussion-peek', 'Dawn and discussion', 'Seer holds Peek: marks', {
    snap: day('p3', 'discussion', { dead: deadRohan, marks: { p6: 'wolf', p2: 'wolf', p4: 'notwolf' }, notes: [{ round: 1, text: 'Rohan is a werewolf' }, { round: 2, text: 'Kabir is a werewolf' }] }),
    ui: { sticky: { eye: true } },
  });
  add('discussion-ghost', 'Dawn and discussion', 'Ghost during the day', { snap: day('p9', 'discussion', { round: 1 }) });
  add('discussion-no-timer', 'Dawn and discussion', 'Host ends the discussion', { snap: day('p4', 'discussion', { round: 1, left: null }) });
  add('discussion-roles', 'Dawn and discussion', 'Roles in this game sheet', { snap: day('p3', 'discussion', { round: 1 }), ui: { sheet: 'roles' } });

  const shotDead = { ...deadDev, p7: { cause: 'night', revealed: { kind: 'role', value: 'hunter' } } };
  const shotAnn = [{ kind: 'death', playerId: 'p9', text: 'Dev was found dead.' }, { kind: 'death', playerId: 'p7', text: 'Nisha was found dead.' }];
  add('shot-hunter', 'Hunter', 'Hunter aims', { snap: day('p7', 'shot', { round: 1, dead: shotDead, left: 24, label: 'Shot', dayx: { announcements: shotAnn, shooter: 'p7', shot: { targets: alive(DEAL, shotDead) } } }), ui: { pick: ['p6'] } });
  add('shot-wait', 'Hunter', 'Everyone waits for the Hunter', { snap: day('p3', 'shot', { round: 1, dead: shotDead, left: 21, label: 'Shot', dayx: { announcements: shotAnn, shooter: 'p7' } }) });
  add('shot-host-skip', 'Hunter', 'Host can skip an offline Hunter', {
    snap: (() => { const s = day('p1', 'shot', { round: 1, dead: shotDead, left: 18, label: 'Shot', host: ['skip-shot'], dayx: { announcements: shotAnn, shooter: 'p7' } }); s.room.players.find((p) => p.id === 'p7').connected = false; return s; })(),
  });

  const eligible = alive(DEAL, deadDev);
  const vote = (o = {}) => ({ eligible, voted: ['p1', 'p2', 'p4', 'p6', 'p8'], myVote: null, blocked: [], live: null, canVote: true, ...o });
  add('vote', 'Vote', 'Secret vote, waiting line', { snap: day('p3', 'vote', { round: 1, left: 41, label: 'Vote closes', dayx: { vote: vote() } }) });
  add('vote-voted', 'Vote', 'Voted, can change', { snap: day('p3', 'vote', { round: 1, left: 33, label: 'Vote closes', dayx: { vote: vote({ voted: ['p1', 'p2', 'p3', 'p4', 'p6', 'p8'], myVote: 'p6' }) } }) });
  add('vote-skip', 'Vote', 'Chose to skip', { snap: day('p3', 'vote', { round: 1, left: 30, label: 'Vote closes', dayx: { vote: vote({ voted: ['p1', 'p2', 'p3'], myVote: 'skip' }) } }) });
  add('vote-live', 'Vote', 'Live voting', {
    snap: day('p3', 'vote', { round: 1, left: 37, label: 'Vote closes', dayx: { vote: vote({ voted: ['p1', 'p2', 'p4', 'p6', 'p8'], live: { p1: 'p6', p2: 'p4', p4: 'p6', p6: 'p4', p8: 'skip' } }) } }),
  });
  add('vote-lover', 'Vote', 'Lover blocked, held Peek', { snap: day('p3', 'vote', { round: 1, left: 39, label: 'Vote closes', knows: { lover: { id: 'p5', sameTeam: true } }, dayx: { vote: vote({ blocked: ['p5'] }) } }), ui: { sticky: { eye: true } } });
  add('vote-ghost', 'Vote', 'Ghost watches the vote', { snap: day('p9', 'vote', { round: 1, left: 35, label: 'Vote closes', dayx: { vote: vote({ canVote: false }) } }) });
  add('vote-host', 'Vote', 'Host: end vote', { snap: day('p1', 'vote', { round: 1, left: 28, label: 'Vote closes', host: ['end-vote', 'pause', 'extend'], dayx: { vote: vote({ myVote: 'p6', voted: ['p1', 'p2', 'p4', 'p6', 'p8'] }) } }) });

  const votes = { p1: 'p6', p2: 'p4', p3: 'p6', p4: 'p6', p5: 'p6', p6: 'p4', p7: 'p6', p8: 'skip' };
  const verdict = (o) => ({ votes, tally: { p6: 5, p4: 2, skip: 1 }, outcome: 'eliminated', eliminated: 'p6', text: 'Rohan was voted out. Rohan was a Werewolf.', ...o });
  add('verdict', 'Verdict', 'Eliminated, role revealed', { snap: day('p3', 'verdict', { round: 1, dead: deadRohan, left: 16, label: 'Night falls', dayx: { vote: vote(), verdict: verdict() } }) });
  add('verdict-prince', 'Verdict', 'The Prince survives', {
    snap: day('p3', 'verdict', { round: 1, left: 15, label: 'Night falls', known: { p4: 'prince' }, deal: { ...DEAL, p4: 'prince' },
      dayx: { vote: vote(), verdict: verdict({ votes: { ...votes, p1: 'p4', p3: 'p4', p5: 'p4', p7: 'p4' }, outcome: 'prince', eliminated: null, text: 'Ishaan is the Prince and survives the vote.' }) } }),
  });
  add('verdict-tie', 'Verdict', 'Tie: nobody leaves', {
    snap: day('p3', 'verdict', { round: 1, left: 14, label: 'Night falls', dayx: { vote: vote(), verdict: verdict({ votes: { p1: 'p6', p2: 'p4', p3: 'p6', p4: 'p6', p5: 'p4', p6: 'p4' }, outcome: 'tie', eliminated: null, text: 'A tie between Rohan and Ishaan. Nobody is eliminated.' }) } }),
  });
  add('verdict-skip', 'Verdict', 'Skip on top', {
    snap: day('p3', 'verdict', { round: 1, left: 12, label: 'Night falls', dayx: { vote: vote(), verdict: verdict({ votes: { p1: 'skip', p2: 'skip', p3: 'p6', p4: 'skip', p5: 'p4' }, outcome: 'skip', eliminated: null, text: 'Skip got the most votes. Nobody is eliminated.' }) } }),
  });
  add('verdict-host', 'Verdict', 'Host: night falls', { snap: day('p1', 'verdict', { round: 1, dead: deadRohan, left: 11, label: 'Night falls', host: ['next-night'], dayx: { vote: vote(), verdict: verdict() } }) });
  add('death-vote', 'Verdict', 'Death moment: voted out', { snap: day('p6', 'verdict', { round: 1, dead: deadRohan, left: 17, label: 'Night falls', known: { p2: 'werewolf' }, dayx: { vote: vote(), verdict: verdict() } }), ui: { death: 'vote' } });
  add('death-night', 'Dawn and discussion', 'Death moment: the wolves', { snap: day('p9', 'discussion', { round: 1 }), ui: { death: 'wolves' } });
  add('reconnecting', 'Dawn and discussion', 'Reconnecting banner', { snap: day('p3', 'discussion', { round: 1 }), banner: true });
}

/* Game over, late arrival, sheets and dialogs */
function defineOver({ add, game, snap, ingame, room, nightTask, deadRohan, deadline }) {
  const endDead = { ...deadRohan, p2: { cause: 'vote', revealed: { kind: 'role', value: 'werewolf' } }, p4: { cause: 'wolves', revealed: { kind: 'role', value: 'doctor' } } };
  const over = (you, winner, extra = {}) => snap(ingame({ you, ready: [] }), game({
    you, phase: 'over', round: 3, dead: endDead, winner, history: HISTORY,
    day: { stage: 'verdict', announcements: [], shooter: null, shot: null, vote: null, verdict: null }, ...extra,
  }));
  const village = { team: 'village', winners: ['p1', 'p3', 'p4', 'p5', 'p7', 'p8', 'p9'], title: 'The village wins', text: 'Every killer wolf is dead. Kabir and Rohan were the werewolves.' };
  add('over-village', 'Game over', 'Village wins (you won)', { snap: over('p3', village) });
  add('over-host', 'Game over', 'Host: play again', { snap: over('p1', village) });
  add('over-wolves', 'Game over', 'Wolves win (you lost)', {
    snap: over('p3', { team: 'wolves', winners: ['p2', 'p6'], title: 'The werewolves win', text: 'The wolves equal everyone else alive, so the village can no longer outvote them.' },
      { dead: { p9: { cause: 'wolves', revealed: { kind: 'role', value: 'villager' } }, p4: { cause: 'poison', revealed: { kind: 'role', value: 'doctor' } }, p3: { cause: 'wolves', revealed: { kind: 'role', value: 'seer' } }, p1: { cause: 'vote', revealed: { kind: 'role', value: 'villager' } }, p8: { cause: 'hunter', revealed: { kind: 'role', value: 'cupid' } } } }),
  });
  add('over-jester', 'Game over', 'Jester wins alone', {
    snap: over('p9', { team: 'jester', winners: ['p9'], title: 'The Jester wins', text: 'The village voted Dev out, and that was the Jester’s plan all along.' },
      { deal: { ...DEAL, p9: 'jester' }, dead: { p9: { cause: 'vote', revealed: { kind: 'role', value: 'jester' } } } }),
  });
  add('over-lovers', 'Game over', 'Lovers win', {
    snap: over('p2', { team: 'lovers', winners: ['p2', 'p5'], title: 'The Lovers win', text: 'Kabir and Tara are the last two alive, a werewolf and a villager in love.' },
      { dead: { p1: { cause: 'wolves' }, p3: { cause: 'wolves' }, p4: { cause: 'vote' }, p6: { cause: 'vote' }, p7: { cause: 'poison' }, p8: { cause: 'hunter' }, p9: { cause: 'wolves' } } }),
  });
  add('over-ghost', 'Game over', 'Ghost score', { snap: over('p9', village, { ghost: { guess: null, score: { right: 2, total: 3 } } }) });

  // Someone who joined mid-game sees the public view with me: null.
  const lateRoom = room({ you: 'p10', extra: 1, ready: 'all', left: ['p8'], offline: ['p7'], over: { p10: { inGame: false, ready: false } } });
  add('late', 'Other', 'Joined mid-game', {
    snap: snap(lateRoom, (() => { const g = game({ you: null, phase: 'day', round: 2, dead: deadRohan, deadline: deadline(122, 'Voting starts'), day: { stage: 'discussion', announcements: [], shooter: null, shot: null, vote: null, verdict: null } }); g.me = null; return g; })()),
  });
  add('menu-host', 'Other', 'In-game menu for the host', {
    snap: snap(ingame({ you: 'p1' }), game({ you: 'p1', phase: 'night', round: 2, dead: deadRohan, night: nightTask({ kind: 'decoy', prompt: 'Who do you suspect?', targets: ['p2', 'p3', 'p4', 'p5', 'p7', 'p8'] }), deadline: deadline(70, 'Night ends') })),
    ui: { sheet: 'menu' },
  });
  add('transfer-host', 'Other', 'Hand host to someone', {
    snap: snap(ingame({ you: 'p1', offline: ['p7'] }), game({ you: 'p1', phase: 'day', round: 2, dead: deadRohan, deadline: deadline(120, 'Voting starts'), day: { stage: 'discussion', announcements: [], shooter: null, shot: null, vote: null, verdict: null }, hostActions: ['start-vote', 'pause', 'extend'] })),
    ui: { sheet: 'transfer' },
  });
  add('confirm-host', 'Other', 'Host confirms an action', {
    snap: snap(ingame({ you: 'p1' }), game({ you: 'p1', phase: 'day', round: 2, dead: deadRohan, deadline: deadline(96, 'Voting starts'), day: { stage: 'discussion', announcements: [], shooter: null, shot: null, vote: null, verdict: null }, hostActions: ['start-vote', 'pause', 'extend'] })),
    ui: { dialog: { title: 'End the discussion?', text: 'Voting opens for everyone straight away.', yes: 'Start the vote' } },
  });
  add('guide', 'Other', 'Role guide', { snap: snap(room({ ready: [] })), ui: { sheet: 'guide' } });
}

export function buildMocks(opts = {}) {
  const ctx = makeContext(opts);
  defineLobby(ctx);
  defineReveal(ctx);
  defineNight(ctx);
  defineDay(ctx);
  defineOver(ctx);
  return ctx.M;
}
