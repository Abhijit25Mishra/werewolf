'use strict';
// Pure rules engine (PLAN.md section 5, docs/ENGINE_API.md, docs/PROTOCOL.md).
// State is plain JSON: no Map, Set, class instances or functions. No I/O, no real timers.
// Randomness after dealing (tie-breaks, the order of dawn deaths) comes from a PRNG whose
// state lives in `state.rngState`, seeded once from the `rng` passed to createGame.

const R = require('./roles');

const TIMERS = Object.freeze({
  revealMs: 60000,
  shotMs: 30000,
  verdictMs: 20000,
  packLockLeadMs: 20000,
  witchMinMs: 20000,
  extendMs: 30000,
});

const DEFAULT_SETTINGS = Object.freeze({
  reveal: 'role',
  firstNightKill: true,
  deadSeeRoles: false,
  voteStyle: 'secret',
  discussionSeconds: 180,
  voteSeconds: 60,
  nightSeconds: 90,
  nightMinSeconds: 20,
});

const REVEAL_MODES = ['role', 'day', 'team', 'wolf', 'none'];
const VOTE_STYLES = ['secret', 'live'];
const HOST_ACTIONS = ['start-night', 'start-vote', 'end-vote', 'skip-shot', 'next-night', 'pause', 'resume', 'extend'];

class GameError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'GameError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new GameError(code, message);
}

// ---------------------------------------------------------------- randomness

// mulberry32 over a uint32 kept in state, so state stays JSON and replays are deterministic.
function rand(state) {
  state.rngState = (state.rngState + 0x6d2b79f5) >>> 0;
  let t = state.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const randomPick = (state, list) => list[Math.floor(rand(state) * list.length)];
const randomOrder = (state, list) => R.shuffled(() => rand(state), list);

// ---------------------------------------------------------------- small helpers

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const inGame = (state, id) => typeof id === 'string' && has(state.players, id);
const isAlive = (state, id) => inGame(state, id) && state.players[id].alive;
const aliveIds = (state) => state.order.filter((id) => state.players[id].alive);
const nameOf = (state, id) => state.players[id].name;
const roleOf = (state, id) => state.players[id].role;
const roleName = (role) => R.ROLE_BY_ID[role].name;
const livingKillers = (state) => aliveIds(state).filter((id) => R.isKiller(roleOf(state, id)));
const byOrder = (state) => (a, b) => state.order.indexOf(a) - state.order.indexOf(b);
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

function partnerOf(state, id) {
  const l = state.lovers;
  if (!l) return null;
  if (l[0] === id) return l[1];
  if (l[1] === id) return l[0];
  return null;
}

// Lovers from opposite teams (the solo Jester counts as its own team).
function loversOpposite(state) {
  const l = state.lovers;
  return !!l && R.teamOf(roleOf(state, l[0])) !== R.teamOf(roleOf(state, l[1]));
}

const scaled = (state, ms) => Math.round(ms / state.timeScale);
// While paused the clock stands still at the moment of the pause.
const clock = (state, now) => (state.paused ? state.paused.at : now);

function addNote(state, id, text) {
  (state.notes[id] = state.notes[id] || []).push({ round: state.round, text });
}

function addMark(state, viewer, target, mark) {
  (state.marks[viewer] = state.marks[viewer] || {})[target] = mark;
}

function logPublic(state, phase, text) {
  state.log.push({ round: state.round, phase, text });
}

function logSecret(state, phase, text) {
  state.history.push({ round: state.round, phase, text });
}

// ---------------------------------------------------------------- setup

function checkSettings(input) {
  const s = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (input && input[k] !== undefined) s[k] = input[k];
  const num = (v, min) => typeof v === 'number' && Number.isFinite(v) && v >= min;
  if (!REVEAL_MODES.includes(s.reveal)) fail('BAD_SETTINGS', 'Unknown reveal setting');
  if (!VOTE_STYLES.includes(s.voteStyle)) fail('BAD_SETTINGS', 'Unknown vote style');
  if (typeof s.firstNightKill !== 'boolean' || typeof s.deadSeeRoles !== 'boolean') fail('BAD_SETTINGS', 'Bad switch');
  if (!num(s.discussionSeconds, 0) || !num(s.voteSeconds, 1) || !num(s.nightSeconds, 1) || !num(s.nightMinSeconds, 0)) {
    fail('BAD_SETTINGS', 'Bad timer setting');
  }
  if (s.nightMinSeconds > s.nightSeconds) fail('BAD_SETTINGS', 'The night minimum is longer than the night');
  return s;
}

// Deal the deck in join order. `assign` (test-only) fixes some players' roles first.
function deal(players, counts, rng, assign) {
  const deck = [];
  for (const id of R.ROLE_IDS) for (let i = 0; i < (counts[id] || 0); i++) deck.push(id);
  const dealt = {};
  if (assign) {
    if (typeof assign !== 'object') fail('BAD_REQUEST', 'assign must map player ids to roles');
    const ids = players.map((p) => p.id);
    for (const [pid, role] of Object.entries(assign)) {
      if (!ids.includes(pid)) fail('BAD_REQUEST', `assign: unknown player ${pid}`);
      const i = deck.indexOf(role);
      if (i < 0) fail('BAD_SETTINGS', `assign: no ${role} left in the deck`);
      deck.splice(i, 1);
      dealt[pid] = role;
    }
  }
  const rest = R.shuffled(rng, deck);
  let k = 0;
  for (const p of players) if (!dealt[p.id]) dealt[p.id] = rest[k++];
  return dealt;
}

function createGame({ players, roles, settings, now = Date.now(), rng = Math.random, timeScale = 1, assign = null } = {}) {
  if (!Array.isArray(players) || players.length < 1) fail('BAD_REQUEST', 'No players');
  const seen = new Set();
  for (const p of players) {
    if (!p || typeof p.id !== 'string' || !p.id || typeof p.name !== 'string') fail('BAD_REQUEST', 'Bad player');
    if (seen.has(p.id)) fail('BAD_REQUEST', 'Duplicate player id');
    seen.add(p.id);
  }
  if (typeof timeScale !== 'number' || !(timeScale > 0)) fail('BAD_REQUEST', 'Bad timeScale');
  if (typeof rng !== 'function') fail('BAD_REQUEST', 'rng must be a function');
  const counts = {};
  for (const [id, n] of Object.entries(roles || {})) if (n) counts[id] = n;
  const errors = R.validateDeck(counts, players.length);
  if (errors.length) fail('BAD_SETTINGS', errors[0]);
  const s = checkSettings(settings);
  const dealt = deal(players, counts, rng, assign);

  const state = {
    v: 1,
    phase: 'reveal',
    round: 1,
    settings: s,
    timeScale,
    rngState: Math.floor(rng() * 4294967296) >>> 0,
    rolesInPlay: counts,
    order: players.map((p) => p.id),
    players: {},
    lovers: null,
    witch: { healUsed: false, poisonUsed: false },
    doctorLast: null,
    wolfCubBonus: false,
    jesterWin: null,
    reveal: { seen: [] },
    night: null,
    day: null,
    deadlines: {},
    paused: null,
    pendingShots: [],
    ghostGuesses: {},
    packVictims: {},
    log: [],
    history: [],
    notes: {},
    marks: {},
    winner: null,
  };
  for (const p of players) {
    const role = dealt[p.id];
    state.players[p.id] = {
      id: p.id, name: p.name, role, alive: true,
      cause: null, diedRound: null, diedPhase: null,
      flags: role === 'elder' ? { elderLife: true } : {},
    };
  }
  state.deadlines.reveal = now + scaled(state, TIMERS.revealMs);
  return state;
}

// ---------------------------------------------------------------- role reveal

function seenRole(state, playerId, now) {
  if (state.phase !== 'reveal') fail('NOT_ALLOWED', 'The role reveal is over');
  if (!inGame(state, playerId)) fail('NOT_ALLOWED', 'You are not in this game');
  if (!state.reveal.seen.includes(playerId)) state.reveal.seen.push(playerId);
  if (state.order.every((id) => state.reveal.seen.includes(id))) startNight(state, now, 1);
}

// ---------------------------------------------------------------- night: tasks

const PROMPTS = {
  cupid: 'Choose two players to fall in love',
  wolf: 'Choose the pack\'s victim',
  meet: 'Meet your pack, then tap Ready',
  seer: 'Choose a player to inspect',
  doctor: 'Choose a player to protect tonight',
  witch: 'Use your potions, or pass',
  sorceress: 'Choose a player to search for the Seer',
  decoy: 'Who do you suspect?',
  ghost: 'Who will the werewolves take tonight?',
};

function taskKind(state, p, round, kill) {
  const r = p.role;
  if (r === 'cupid' && round === 1) return 'cupid';
  if (R.isKiller(r)) return kill ? 'wolf' : 'meet';
  if (r === 'seer' || (r === 'apprentice' && p.flags.promoted)) return 'seer';
  if (r === 'doctor') return 'doctor';
  if (r === 'witch' && (!state.witch.healUsed || !state.witch.poisonUsed)) return 'witch';
  if (r === 'sorceress') return 'sorceress';
  return 'decoy';
}

function startNight(state, now, round) {
  state.phase = 'night';
  state.round = round;
  state.reveal = null;
  state.day = null;
  state.paused = null;
  state.deadlines = {};
  const kill = round > 1 || state.settings.firstNightKill;
  const tasks = {};
  for (const id of state.order) {
    const p = state.players[id];
    tasks[id] = { kind: p.alive ? taskKind(state, p, round, kill) : 'ghost', done: false, submitted: null, result: null };
  }
  const hasPack = state.order.some((id) => tasks[id].kind === 'wolf');
  let pack = null;
  if (hasPack) {
    pack = { slots: state.wolfCubBonus ? 2 : 1, slot: 0, picks: {}, locked: [], done: false };
    state.wolfCubBonus = false;
  }
  state.night = { kill: hasPack, tasks, pack };
  const nightMs = scaled(state, state.settings.nightSeconds * 1000);
  const minMs = scaled(state, state.settings.nightMinSeconds * 1000);
  state.deadlines.nightEnd = now + nightMs;
  if (minMs > 0) state.deadlines.nightMin = now + minMs;
  if (hasPack) state.deadlines.packLock = now + nightMs - scaled(state, TIMERS.packLockLeadMs);
  logPublic(state, 'night', `Night ${round} falls.`);
}

// The pack's legal victims for this wolf in the current slot.
function packTargets(state, wolfId) {
  const pack = state.night.pack;
  if (!pack || pack.done) return [];
  const lover = partnerOf(state, wolfId);
  return aliveIds(state).filter((x) => !R.isKiller(roleOf(state, x)) && x !== lover && !pack.locked.includes(x));
}

const witchWaiting = (state) => !!(state.night.pack && !state.night.pack.done);
const witchVictims = (state) => (state.night.pack && state.night.pack.done ? state.night.pack.locked.slice() : []);

function taskTargets(state, id) {
  const task = state.night.tasks[id];
  const alive = aliveIds(state);
  switch (task.kind) {
    case 'cupid': return alive;
    case 'wolf': return packTargets(state, id);
    case 'seer': case 'sorceress': case 'decoy': return alive.filter((x) => x !== id);
    case 'doctor': return alive.filter((x) => x !== state.doctorLast);
    case 'witch': return witchWaiting(state) || state.witch.poisonUsed ? [] : alive.filter((x) => x !== id);
    case 'ghost': return alive;
    default: return [];
  }
}

function taskDone(state, id) {
  const task = state.night.tasks[id];
  return task.kind === 'wolf' ? state.night.pack.done : task.done;
}

function needTarget(payload) {
  if (typeof payload.target !== 'string' || !payload.target) fail('BAD_REQUEST', 'Choose a player');
  return payload.target;
}

function nightAction(state, playerId, payload, now) {
  if (state.phase !== 'night') fail('NOT_ALLOWED', 'It is not night');
  if (!inGame(state, playerId)) fail('NOT_ALLOWED', 'You are not in this game');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('BAD_REQUEST', 'Malformed action');
  const task = state.night.tasks[playerId];
  const kind = task.kind;
  if (kind === 'wolf' ? state.night.pack.done : task.done) fail('NOT_ALLOWED', 'You have already acted tonight');
  const legal = taskTargets(state, playerId);
  const me = nameOf(state, playerId);
  let out = {};

  if (kind === 'cupid') {
    const t = payload.targets;
    if (!Array.isArray(t) || t.length !== 2 || t.some((x) => typeof x !== 'string')) fail('BAD_REQUEST', 'Choose two players');
    if (t[0] === t[1]) fail('BAD_TARGET', 'Choose two different players');
    if (!t.every((x) => legal.includes(x))) fail('BAD_TARGET', 'Choose two living players');
    task.done = true;
    task.submitted = { targets: [t[0], t[1]] };
    logSecret(state, 'night', `Cupid (${me}) linked ${nameOf(state, t[0])} and ${nameOf(state, t[1])}.`);
  } else if (kind === 'wolf') {
    const target = needTarget(payload);
    if (!legal.includes(target)) fail('BAD_TARGET', 'The pack can\'t take that player');
    const pack = state.night.pack;
    pack.picks[playerId] = target;
    if (livingKillers(state).every((k) => pack.picks[k] === target)) lockSlot(state, target, now);
  } else if (kind === 'meet') {
    task.done = true;
    task.submitted = {};
  } else if (kind === 'witch') {
    if (witchWaiting(state)) fail('NOT_ALLOWED', 'Wait until the werewolves have chosen');
    const heal = payload.heal == null ? null : payload.heal;
    const poison = payload.poison == null ? null : payload.poison;
    if ((heal !== null && typeof heal !== 'string') || (poison !== null && typeof poison !== 'string')) {
      fail('BAD_REQUEST', 'Malformed potions');
    }
    if (heal !== null && (state.witch.healUsed || !witchVictims(state).includes(heal))) fail('BAD_TARGET', 'You can only heal tonight\'s victim');
    if (poison !== null && (state.witch.poisonUsed || !legal.includes(poison))) fail('BAD_TARGET', 'You can\'t poison that player');
    task.done = true;
    task.submitted = { heal, poison };
    const parts = [];
    if (heal) parts.push(`healed ${nameOf(state, heal)}`);
    if (poison) parts.push(`poisoned ${nameOf(state, poison)}`);
    logSecret(state, 'night', `The Witch (${me}) ${parts.length ? parts.join(' and ') : 'kept the potions'}.`);
  } else {
    const target = needTarget(payload);
    if (!legal.includes(target)) fail('BAD_TARGET', 'You can\'t choose that player');
    task.done = true;
    task.submitted = { target };
    const them = nameOf(state, target);
    if (kind === 'seer') {
      const wolf = R.seerSeesWolf(roleOf(state, target));
      const text = `${them} is ${wolf ? 'a werewolf' : 'not a werewolf'}.`;
      task.result = { target, wolf, text };
      addNote(state, playerId, text);
      addMark(state, playerId, target, wolf ? 'wolf' : 'notwolf');
      const who = roleOf(state, playerId) === 'seer' ? 'The Seer' : 'The Apprentice Seer';
      logSecret(state, 'night', `${who} (${me}) checked ${them}: ${wolf ? 'a werewolf' : 'not a werewolf'}.`);
      out = { result: clone(task.result) };
    } else if (kind === 'sorceress') {
      const t = state.players[target];
      const seer = t.role === 'seer' || (t.role === 'apprentice' && !!t.flags.promoted);
      const text = `${them} ${seer ? 'is the Seer' : 'is not the Seer'}.`;
      task.result = { target, seer, text };
      addNote(state, playerId, text);
      addMark(state, playerId, target, seer ? 'seer' : 'notseer');
      logSecret(state, 'night', `The Sorceress (${me}) searched ${them}: ${seer ? 'the Seer' : 'not the Seer'}.`);
      out = { result: clone(task.result) };
    } else if (kind === 'doctor') {
      logSecret(state, 'night', `The Doctor (${me}) protected ${them}.`);
    } else if (kind === 'decoy') {
      logSecret(state, 'night', `${me} suspected ${them}.`);
    } else if (kind === 'ghost') {
      (state.ghostGuesses[state.round] = state.ghostGuesses[state.round] || {})[playerId] = target;
      logSecret(state, 'night', `${me}'s ghost guessed ${them}.`);
    }
  }
  maybeEndNight(state, now);
  return out;
}

// ---------------------------------------------------------------- night: the pack and the Witch

function lockSlot(state, victim, now) {
  const pack = state.night.pack;
  if (victim) pack.locked.push(victim);
  pack.picks = {};
  pack.slot += 1;
  const noneLeft = livingKillers(state).every((k) => packTargets(state, k).length === 0);
  if (pack.slot >= pack.slots || noneLeft) packDone(state, now, false);
}

function packDone(state, now, forced) {
  const pack = state.night.pack;
  pack.done = true;
  pack.slot = pack.slots;
  delete state.deadlines.packLock;
  state.packVictims[state.round] = pack.locked.slice();
  const names = pack.locked.map((id) => nameOf(state, id)).join(' and ');
  let text;
  if (!pack.locked.length) text = forced ? 'The pack ran out of time without a pick: no kill.' : 'The pack chose nobody.';
  else text = forced ? `The pack ran out of time; its top pick stands: ${names}.` : `The pack agreed on ${names}.`;
  logSecret(state, 'night', text);
  // Once the pack locks, the Witch gets at least witchMinMs before the night can end.
  const witchId = state.order.find((id) => state.night.tasks[id].kind === 'witch');
  if (witchId && !state.night.tasks[witchId].done) {
    const min = clock(state, now) + scaled(state, TIMERS.witchMinMs);
    if (state.deadlines.nightEnd < min) state.deadlines.nightEnd = min;
  }
}

// packLockLeadMs before the night deadline: the plurality pick of the current slot stands
// (seeded random tie-break); slots nobody picked for stay empty.
function forcePackLock(state, now) {
  const pack = state.night && state.night.pack;
  if (!pack || pack.done) return;
  const tally = {};
  for (const k of livingKillers(state)) {
    const t = pack.picks[k];
    if (t) tally[t] = (tally[t] || 0) + 1;
  }
  const top = Math.max(0, ...Object.values(tally));
  if (top > 0) {
    const best = Object.keys(tally).filter((t) => tally[t] === top).sort(byOrder(state));
    pack.locked.push(best.length === 1 ? best[0] : randomPick(state, best));
  }
  pack.picks = {};
  packDone(state, now, true);
}

function maybeEndNight(state, now) {
  if (state.phase !== 'night') return;
  const min = state.deadlines.nightMin;
  if (min !== undefined && clock(state, now) < min) return;
  const allDone = state.order.every((id) => state.night.tasks[id].kind === 'ghost' || taskDone(state, id));
  if (allDone) resolveNight(state, now);
}

// ---------------------------------------------------------------- deaths

const newBatch = () => ({ deaths: [], news: [] });

// The death cascade (PLAN.md section 5): every death goes through here.
function kill(state, id, cause, phase, batch) {
  const p = state.players[id];
  if (!p.alive) return;
  p.alive = false;
  p.cause = cause;
  p.diedRound = state.round;
  p.diedPhase = phase;
  batch.deaths.push(id);
  const partner = partnerOf(state, id);
  if (partner && state.players[partner].alive) kill(state, partner, 'heartbreak', phase, batch);
  if (p.role === 'hunter') state.pendingShots.push(id);
  if (p.role === 'wolfcub') state.wolfCubBonus = true;
  if (p.role === 'seer') {
    for (const a of state.order) {
      const q = state.players[a];
      if (q.role === 'apprentice' && q.alive && !q.flags.promoted) {
        q.flags.promoted = true;
        const text = 'The Seer is dead. From the next night, you check a player each night as the Seer.';
        batch.news.push({ to: a, text });
        addNote(state, a, text);
        logSecret(state, phase, `${q.name}, the Apprentice Seer, inherited the Seer's power.`);
      }
    }
  }
}

// What the reveal setting shows about a dead player (everything once the game is over).
function revealOf(state, id) {
  const p = state.players[id];
  if (p.alive) return null;
  if (state.phase === 'over') return { kind: 'role', value: p.role };
  const mode = state.settings.reveal;
  if (mode === 'role' || (mode === 'day' && p.diedPhase === 'day')) return { kind: 'role', value: p.role };
  if (mode === 'team') return { kind: 'team', value: R.teamOf(p.role) };
  if (mode === 'wolf') return { kind: 'wolf', value: R.isKiller(p.role) };
  return null;
}

const TEAM_WORDS = { village: 'the village', wolves: 'the werewolves', solo: 'their own' };

function revealText(state, id) {
  const r = revealOf(state, id);
  if (!r) return '';
  if (r.kind === 'role') return ` They were the ${roleName(r.value)}.`;
  if (r.kind === 'team') return ` They were on ${TEAM_WORDS[r.value]} team.`;
  return r.value ? ' They were a werewolf.' : ' They were not a werewolf.';
}

// Public announcements and log lines for a batch of deaths, plus private news.
function announce(state, batch, phase, firstText) {
  const ann = state.day.announcements;
  const ids = phase === 'night' ? randomOrder(state, batch.deaths) : batch.deaths;
  ids.forEach((id, i) => {
    const p = state.players[id];
    let text;
    if (p.cause === 'heartbreak') text = `${p.name} died of a broken heart.`;
    else if (i === 0 && firstText) text = firstText;
    else text = phase === 'night' ? `${p.name} was found dead.` : `${p.name} died.`;
    text += revealText(state, id);
    ann.push({ kind: 'death', playerId: id, text });
    logPublic(state, phase === 'night' ? 'night' : 'day', text);
  });
  for (const n of batch.news) ann.push({ kind: 'private', to: n.to, text: n.text });
}

// ---------------------------------------------------------------- night resolution

function resolveNight(state, now) {
  if (state.night.pack && !state.night.pack.done) forcePackLock(state, now);
  const tasks = state.night.tasks;
  const holder = (kind) => state.order.find((id) => tasks[id].kind === kind && tasks[id].done);
  const news = [];
  // 1. Cupid's link takes effect; both lovers learn their partner at dawn.
  const cupid = holder('cupid');
  if (cupid) {
    const [a, b] = tasks[cupid].submitted.targets;
    state.lovers = [a, b];
    const same = R.teamOf(roleOf(state, a)) === R.teamOf(roleOf(state, b));
    for (const [x, y] of [[a, b], [b, a]]) {
      const text = `You are in love with ${nameOf(state, y)}. ${same
        ? 'You are on the same team.'
        : 'You are on different teams: you can only win together, as the last two alive.'}`;
      news.push({ to: x, text });
      addNote(state, x, text);
    }
  }
  // 2. Collect the pack's victims, the Doctor's protection and the Witch's potions.
  const victims = state.night.pack ? state.night.pack.locked.slice() : [];
  const doctor = holder('doctor');
  const protectedId = doctor ? tasks[doctor].submitted.target : null;
  const witch = holder('witch');
  const potions = witch ? tasks[witch].submitted : { heal: null, poison: null };
  const deaths = [];
  // 3. Each pack victim: Doctor, then heal, then the Elder's extra life.
  for (const v of victims) {
    const p = state.players[v];
    if (v === protectedId) { logSecret(state, 'night', `The Doctor saved ${p.name}.`); continue; }
    if (v === potions.heal) { logSecret(state, 'night', `The Witch's heal saved ${p.name}.`); continue; }
    if (p.role === 'elder' && p.flags.elderLife) {
      p.flags.elderLife = false;
      const text = 'The werewolves attacked you, but you survived. Your extra life is gone.';
      news.push({ to: v, text });
      addNote(state, v, text);
      logSecret(state, 'night', `The Elder (${p.name}) survived the attack and lost the extra life.`);
      continue;
    }
    deaths.push([v, 'wolves']);
  }
  // 4. Poison, unless the Doctor protected the target.
  if (potions.poison) {
    if (potions.poison === protectedId) logSecret(state, 'night', `The Doctor saved ${nameOf(state, potions.poison)} from the poison.`);
    else if (!deaths.some(([id]) => id === potions.poison)) deaths.push([potions.poison, 'poison']);
  }
  // 5. The death cascade.
  const batch = newBatch();
  for (const [id, cause] of deaths) kill(state, id, cause, 'night', batch);
  // 6. Remember the protection; potions are spent even if they changed nothing.
  state.doctorLast = protectedId;
  if (potions.heal) state.witch.healUsed = true;
  if (potions.poison) state.witch.poisonUsed = true;
  // 7. Dawn.
  state.phase = 'day';
  state.night = null;
  state.deadlines = {};
  state.paused = null;
  state.day = { stage: 'discussion', after: null, announcements: [], votes: {}, verdict: null, shooter: null };
  if (!batch.deaths.length) {
    state.day.announcements.push({ kind: 'info', text: 'Nobody died last night.' });
    logPublic(state, 'night', 'Nobody died in the night.');
  }
  batch.news = news.concat(batch.news);
  announce(state, batch, 'night');
  afterDeaths(state, now, 'discussion');
}

// ---------------------------------------------------------------- win checks

const WIN_TEXT = {
  jester: ['The Jester wins', 'The village voted out the Jester.'],
  lovers: ['The Lovers win', 'The Lovers are the last two alive.'],
  village: ['The village wins', 'Every killer wolf is dead.'],
  wolves: ['The werewolves win', 'The wolves equal or outnumber everyone else.'],
};

// Every member of the team, dead or alive, except opposite-team Lovers (they only win as Lovers).
function teamWinners(state, team) {
  const opp = loversOpposite(state);
  return state.order.filter((id) => R.teamOf(roleOf(state, id)) === team && !(opp && state.lovers.includes(id)));
}

function makeWin(state, team, winners, text) {
  const [title, body] = WIN_TEXT[team];
  return { team, winners, title, text: text || body };
}

// PLAN.md "Win conditions", in order.
function winCheck(state) {
  if (state.jesterWin) return makeWin(state, 'jester', [state.jesterWin]);
  const alive = aliveIds(state);
  const opp = loversOpposite(state);
  if (opp && alive.length === 2 && state.lovers.every((id) => alive.includes(id))) {
    return makeWin(state, 'lovers', state.lovers.slice());
  }
  if (!alive.some((id) => R.isKiller(roleOf(state, id)))) {
    return makeWin(state, 'village', teamWinners(state, 'village'),
      alive.length ? null : 'Nobody is left alive, and no werewolf survived.');
  }
  const wolfSide = alive.filter((id) => R.teamOf(roleOf(state, id)) === 'wolves' && !(opp && state.lovers.includes(id)));
  if (wolfSide.length >= alive.length - wolfSide.length) return makeWin(state, 'wolves', teamWinners(state, 'wolves'));
  return null;
}

function endGame(state, win) {
  state.phase = 'over';
  state.deadlines = {};
  state.paused = null;
  state.pendingShots = [];
  state.winner = win;
  logPublic(state, 'day', `${win.title}. ${win.text}`);
}

// After every batch of deaths: a Village or Jester win ends the game at once; otherwise a
// queued Hunter's shot comes first, then any other result; otherwise play goes on.
function afterDeaths(state, now, after) {
  const win = winCheck(state);
  if (win && (win.team === 'village' || win.team === 'jester')) return endGame(state, win);
  if (state.pendingShots.length) return startShot(state, now, after);
  if (win) return endGame(state, win);
  if (after === 'verdict') return startVerdict(state, now);
  return startDiscussion(state, now);
}

// ---------------------------------------------------------------- day stages

function setStage(state, stage) {
  state.day.stage = stage;
  state.deadlines = {};
  state.paused = null;
}

function startShot(state, now, after) {
  setStage(state, 'shot');
  state.day.shooter = state.pendingShots[0];
  state.day.after = after;
  state.deadlines.shot = now + scaled(state, TIMERS.shotMs);
}

function startDiscussion(state, now) {
  setStage(state, 'discussion');
  state.day.after = null;
  state.day.shooter = null;
  if (state.settings.discussionSeconds > 0) {
    state.deadlines.discussion = now + scaled(state, state.settings.discussionSeconds * 1000);
  }
}

function startVote(state, now) {
  setStage(state, 'vote');
  state.day.votes = {};
  state.deadlines.vote = now + scaled(state, state.settings.voteSeconds * 1000);
}

function startVerdict(state, now) {
  setStage(state, 'verdict');
  state.day.after = null;
  state.day.shooter = null;
  state.deadlines.verdict = now + scaled(state, TIMERS.verdictMs);
}

function shoot(state, playerId, target, now) {
  if (state.phase !== 'day' || state.day.stage !== 'shot' || state.day.shooter !== playerId) {
    fail('NOT_ALLOWED', 'It is not your shot');
  }
  if (typeof target !== 'string' || !target) fail('BAD_REQUEST', 'Choose a player');
  if (target === playerId || !isAlive(state, target)) fail('BAD_TARGET', 'Choose a living player');
  state.pendingShots.shift();
  state.players[playerId].flags.shot = true;
  state.day.shooter = null;
  const batch = newBatch();
  kill(state, target, 'hunter', 'day', batch);
  announce(state, batch, 'day', `${nameOf(state, playerId)}, the Hunter, shot ${nameOf(state, target)}.`);
  afterDeaths(state, now, state.day.after);
}

// No pick within the shot timer, or the host skipped an offline Hunter: no shot.
function noShot(state, now, why) {
  const id = state.pendingShots.shift();
  state.day.shooter = null;
  const text = why === 'skip' ? `The host skipped ${nameOf(state, id)}'s shot.` : `${nameOf(state, id)} didn't shoot.`;
  state.day.announcements.push({ kind: 'info', text });
  logPublic(state, 'day', text);
  afterDeaths(state, now, state.day.after);
}

function vote(state, playerId, target, now) {
  if (state.phase !== 'day' || state.day.stage !== 'vote') fail('NOT_ALLOWED', 'Voting is not open');
  if (!isAlive(state, playerId)) fail('NOT_ALLOWED', 'Only living players vote');
  if (typeof target !== 'string' || !target) fail('BAD_REQUEST', 'Choose a player or Skip');
  if (target !== 'skip') {
    if (target === playerId || !isAlive(state, target)) fail('BAD_TARGET', 'Choose another living player');
    if (partnerOf(state, playerId) === target) fail('BAD_TARGET', 'You can\'t vote for your lover');
  }
  state.day.votes[playerId] = target;
  if (aliveIds(state).every((id) => has(state.day.votes, id))) closeVote(state, now);
}

function closeVote(state, now) {
  const d = state.day;
  const votes = {};
  for (const id of state.order) if (has(d.votes, id)) votes[id] = d.votes[id];
  const tally = {};
  for (const t of Object.values(votes)) tally[t] = (tally[t] || 0) + 1;
  const top = Math.max(0, ...Object.values(tally));
  const leaders = Object.keys(tally).filter((t) => tally[t] === top);
  let outcome;
  let eliminated = null;
  let text;
  if (top === 0) {
    outcome = 'none';
    text = 'Nobody voted, so nobody is eliminated.';
  } else if (leaders.includes('skip')) {
    outcome = 'skip';
    text = 'Skip has the most votes, so nobody is eliminated.';
  } else if (leaders.length > 1) {
    outcome = 'tie';
    text = 'A tie, so nobody is eliminated.';
  } else {
    const p = state.players[leaders[0]];
    if (p.role === 'prince' && !p.flags.princeUsed) {
      p.flags.princeUsed = true;
      outcome = 'prince';
      text = `${p.name} is the Prince, and survives the vote.`;
    } else {
      outcome = 'eliminated';
      eliminated = p.id;
      if (p.role === 'jester') state.jesterWin = p.id;
    }
  }
  d.votes = votes;
  if (outcome !== 'eliminated') {
    d.verdict = { votes, tally, outcome, eliminated, text };
    logPublic(state, 'day', text);
    return startVerdict(state, now);
  }
  const batch = newBatch();
  kill(state, eliminated, 'vote', 'day', batch);
  text = `${nameOf(state, eliminated)} was voted out.${revealText(state, eliminated)}`;
  d.verdict = { votes, tally, outcome, eliminated, text };
  batch.deaths.shift();
  logPublic(state, 'day', text);
  d.announcements.push({ kind: 'death', playerId: eliminated, text });
  announce(state, batch, 'day');
  afterDeaths(state, now, 'verdict');
}

// ---------------------------------------------------------------- timers and host controls

// The deadline the countdown shows for the current phase or stage.
function mainDeadlineKey(state) {
  let key = null;
  if (state.phase === 'reveal') key = 'reveal';
  else if (state.phase === 'night') key = 'nightEnd';
  else if (state.phase === 'day') key = state.day.stage;
  return key && has(state.deadlines, key) ? key : null;
}

const DEADLINE_LABELS = {
  reveal: 'Night falls',
  nightEnd: 'Night ends',
  shot: 'The Hunter takes aim',
  discussion: 'Discussion ends',
  vote: 'Voting closes',
  verdict: 'Night falls',
};

const online = (ctx, id) => !(ctx && typeof ctx.isOnline === 'function') || !!ctx.isOnline(id);

function hostActionsFor(state, ctx) {
  const acts = [];
  if (state.phase === 'over') return acts;
  if (state.phase === 'reveal') acts.push('start-night');
  if (state.phase === 'day') {
    const st = state.day.stage;
    if (st === 'discussion') acts.push('start-vote');
    if (st === 'vote') acts.push('end-vote');
    if (st === 'shot' && !online(ctx, state.day.shooter)) acts.push('skip-shot');
    if (st === 'verdict') acts.push('next-night');
  }
  if (mainDeadlineKey(state)) acts.push(state.paused ? 'resume' : 'pause', 'extend');
  return acts;
}

function hostAction(state, action, now, ctx = {}) {
  if (!HOST_ACTIONS.includes(action)) fail('BAD_REQUEST', 'Unknown host action');
  if (!hostActionsFor(state, ctx).includes(action)) {
    fail('NOT_ALLOWED', state.phase === 'night' ? 'Nobody can end a night early' : 'Not allowed right now');
  }
  switch (action) {
    case 'start-night': return startNight(state, now, 1);
    case 'start-vote': return startVote(state, now);
    case 'end-vote': return closeVote(state, now);
    case 'skip-shot': return noShot(state, now, 'skip');
    case 'next-night': return startNight(state, now, state.round + 1);
    case 'pause':
      state.paused = { at: now };
      return undefined;
    case 'resume': {
      const dt = Math.max(0, now - state.paused.at);
      for (const k of Object.keys(state.deadlines)) state.deadlines[k] += dt;
      state.paused = null;
      onDeadline(state, now);
      maybeEndNight(state, now);
      return undefined;
    }
    case 'extend': {
      const key = mainDeadlineKey(state);
      state.deadlines[key] += scaled(state, TIMERS.extendMs);
      if (key === 'nightEnd' && has(state.deadlines, 'packLock')) {
        state.deadlines.packLock = state.deadlines.nightEnd - scaled(state, TIMERS.packLockLeadMs);
      }
      return undefined;
    }
    default: return undefined;
  }
}

// Same-time deadlines fire in this order.
const DEADLINE_ORDER = ['reveal', 'nightMin', 'packLock', 'nightEnd', 'shot', 'discussion', 'vote', 'verdict'];

function fireDeadline(state, key, now) {
  switch (key) {
    case 'reveal': return startNight(state, now, 1);
    case 'nightMin': return maybeEndNight(state, now);
    case 'packLock':
      forcePackLock(state, now);
      return maybeEndNight(state, now);
    case 'nightEnd': return resolveNight(state, now);
    case 'shot': return noShot(state, now, 'timeout');
    case 'discussion': return startVote(state, now);
    case 'vote': return closeVote(state, now);
    case 'verdict': return startNight(state, now, state.round + 1);
    default: return undefined;
  }
}

// Handles every deadline at or before `now`, earliest first; a paused game waits.
function onDeadline(state, now) {
  for (let guard = 0; guard < 100; guard++) {
    if (state.phase === 'over' || state.paused) return;
    const due = Object.keys(state.deadlines)
      .filter((k) => state.deadlines[k] <= now)
      .sort((a, b) => state.deadlines[a] - state.deadlines[b] || DEADLINE_ORDER.indexOf(a) - DEADLINE_ORDER.indexOf(b));
    if (!due.length) return;
    delete state.deadlines[due[0]];
    fireDeadline(state, due[0], now);
  }
}

function nextDeadline(state) {
  if (state.phase === 'over' || state.paused) return null;
  const at = Object.values(state.deadlines);
  return at.length ? Math.min(...at) : null;
}

// ---------------------------------------------------------------- views

// PLAN.md "Who sees whose role". `seeAll` is a dead viewer's deadSeeRoles view.
function canSeeRole(state, viewer, targetId, seeAll) {
  const t = state.players[targetId];
  if (state.phase === 'over') return true;
  if (viewer && viewer.id === targetId) return true;
  if (t.flags.princeUsed || t.flags.shot) return true;
  const r = revealOf(state, targetId);
  if (r && r.kind === 'role') return true;
  if (!viewer) return false;
  if (seeAll) return true;
  if (R.isKiller(t.role) && (R.isKiller(viewer.role) || viewer.role === 'minion')) return true;
  return viewer.role === 'mason' && t.role === 'mason';
}

function taskView(state, id) {
  const task = state.night.tasks[id];
  const done = taskDone(state, id);
  const v = {
    kind: task.kind,
    done,
    prompt: PROMPTS[task.kind],
    targets: done ? [] : taskTargets(state, id),
    choose: task.kind === 'cupid' ? 2 : 1,
  };
  if (task.kind === 'wolf') {
    const pack = state.night.pack;
    if (pack.slots > 1) v.prompt = `Choose the pack's victim ${Math.min(pack.slot, pack.slots - 1) + 1} of ${pack.slots}`;
    v.wolf = { slot: Math.min(pack.slot + 1, pack.slots), slots: pack.slots, picks: { ...pack.picks }, locked: pack.locked.slice() };
    if (pack.picks[id]) v.submitted = { target: pack.picks[id] };
  } else if (task.kind === 'witch') {
    const waiting = witchWaiting(state);
    const victims = !waiting && !state.witch.healUsed ? witchVictims(state) : [];
    v.witch = { waiting, victims, canHeal: !state.witch.healUsed && victims.length > 0, canPoison: !state.witch.poisonUsed };
  }
  if (task.result) v.result = clone(task.result);
  if (task.submitted && task.kind !== 'wolf') v.submitted = clone(task.submitted);
  return v;
}

function voteView(state, me) {
  const d = state.day;
  const alive = aliveIds(state);
  const canVote = !!me && me.alive;
  const partner = me ? partnerOf(state, me.id) : null;
  return {
    eligible: alive,
    voted: alive.filter((id) => has(d.votes, id)),
    myVote: me && has(d.votes, me.id) ? d.votes[me.id] : null,
    blocked: canVote && partner && isAlive(state, partner) ? [partner] : [],
    live: state.settings.voteStyle === 'live' ? { ...d.votes } : null,
    canVote,
  };
}

function dayView(state, playerId, me) {
  const d = state.day;
  const over = state.phase === 'over';
  const shotStage = !over && d.stage === 'shot';
  return {
    stage: d.stage,
    announcements: d.announcements
      .filter((a) => a.kind !== 'private' || a.to === playerId)
      .map((a) => (a.playerId ? { kind: a.kind, text: a.text, playerId: a.playerId } : { kind: a.kind, text: a.text })),
    shooter: shotStage ? d.shooter : null,
    shot: shotStage && me && d.shooter === playerId ? { targets: aliveIds(state).filter((x) => x !== playerId) } : null,
    vote: !over && d.stage === 'vote' ? voteView(state, me) : null,
    verdict: d.verdict ? clone(d.verdict) : null,
  };
}

function ghostView(state, me) {
  if (!me || me.alive) return null;
  const guesses = state.ghostGuesses;
  const tonight = state.phase === 'night' && guesses[state.round] && has(guesses[state.round], me.id)
    ? guesses[state.round][me.id] : null;
  const out = { guess: tonight };
  if (state.phase === 'over') {
    let right = 0;
    let total = 0;
    for (const [round, g] of Object.entries(guesses)) {
      if (!has(g, me.id)) continue;
      total += 1;
      if ((state.packVictims[round] || []).includes(g[me.id])) right += 1;
    }
    out.score = { right, total };
  }
  return out;
}

function deadlineView(state) {
  const key = mainDeadlineKey(state);
  if (!key) return null;
  const at = state.deadlines[key];
  if (state.paused) return { endsAt: null, remainingMs: Math.max(0, at - state.paused.at), label: DEADLINE_LABELS[key] };
  return { endsAt: at, remainingMs: null, label: DEADLINE_LABELS[key] };
}

function viewFor(state, playerId, ctx = {}) {
  const me = inGame(state, playerId) ? state.players[playerId] : null;
  const over = state.phase === 'over';
  // A dead player sees every role with deadSeeRoles on, once any shot of theirs is resolved,
  // and never while holding host controls.
  const seeAll = !!me && !me.alive && state.settings.deadSeeRoles && !ctx.isHost && !state.pendingShots.includes(me.id);
  const players = state.order.map((id) => {
    const p = state.players[id];
    let cause = null;
    if (!p.alive) cause = !over && (p.cause === 'wolves' || p.cause === 'poison') ? 'night' : p.cause;
    return { id, name: p.name, alive: p.alive, role: canSeeRole(state, me, id, seeAll) ? p.role : null, revealed: revealOf(state, id), cause };
  });
  let mine = null;
  if (me) {
    const others = (pred) => state.order.filter((id) => id !== me.id && pred(roleOf(state, id)));
    const partner = partnerOf(state, me.id);
    mine = {
      role: me.role,
      team: R.teamOf(me.role),
      alive: me.alive,
      knows: {
        pack: R.isKiller(me.role) ? others(R.isKiller) : [],
        masons: me.role === 'mason' ? others((r) => r === 'mason') : [],
        wolves: me.role === 'minion' ? others(R.isKiller) : [],
        lover: partner ? { id: partner, sameTeam: R.teamOf(me.role) === R.teamOf(roleOf(state, partner)) } : null,
      },
      notes: clone(state.notes[me.id] || []),
      marks: { ...(state.marks[me.id] || {}) },
    };
  }
  return {
    phase: state.phase,
    round: state.round,
    paused: !!state.paused,
    deadline: deadlineView(state),
    rolesInPlay: { ...state.rolesInPlay },
    players,
    me: mine,
    reveal: state.phase === 'reveal' ? { seen: state.reveal.seen.slice(), youSeen: !!me && state.reveal.seen.includes(me.id) } : null,
    night: state.phase === 'night' ? { task: me ? taskView(state, me.id) : null } : null,
    day: state.day && (state.phase === 'day' || over) ? dayView(state, playerId, me) : null,
    hostActions: ctx.isHost ? hostActionsFor(state, ctx) : [],
    log: clone(state.log),
    winner: clone(state.winner),
    history: over ? clone(state.history) : null,
    ghost: ghostView(state, me),
  };
}

// ---------------------------------------------------------------- queries

const isOver = (state) => state.phase === 'over';
const trueRoles = (state) => Object.fromEntries(state.order.map((id) => [id, state.players[id].role]));

module.exports = {
  TIMERS, DEFAULT_SETTINGS, GameError,
  createGame, seenRole, nightAction, vote, shoot, hostAction, onDeadline,
  nextDeadline, viewFor, inGame, isOver, trueRoles, aliveIds,
};
