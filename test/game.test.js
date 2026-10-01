'use strict';
// Engine unit tests (PLAN.md "Testing plan"). Run: node --test test/game.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/game');
const R = require('../src/roles');

// ---------------------------------------------------------------- helpers

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);

// makeGame({ ana: 'werewolf', ben: 'seer', ... }) deals exactly those roles (test-only `assign`).
function makeGame(assign, settings = {}, opts = {}) {
  const players = Object.keys(assign).map((id) => ({ id, name: cap(id) }));
  const roles = {};
  for (const r of Object.values(assign)) roles[r] = (roles[r] || 0) + 1;
  return G.createGame({
    players, roles, settings, now: 0, rng: seeded(opts.seed || 1), timeScale: opts.timeScale || 1, assign,
  });
}

// Everyone taps Got it at t = 0, so night 1 starts at t = 0.
function startGame(assign, settings, opts) {
  const s = makeGame(assign, settings, opts);
  for (const id of s.order) G.seenRole(s, id, 0);
  assert.equal(s.phase, 'night');
  return s;
}

// A time just before the next pending deadline (so "now" is inside the current stage).
const T = (s) => G.nextDeadline(s) - 1;
const view = (s, id, ctx) => G.viewFor(s, id, ctx);
const task = (s, id) => view(s, id).night.task;
const act = (s, id, payload, t = T(s)) => G.nightAction(s, id, payload, t);
const host = (s, action, t = T(s), ctx = {}) => G.hostAction(s, action, t, ctx);

// Every living player with an open decoy, seer, sorceress, meet or witch task does a
// harmless default (witches pass). Wolves, doctors and cupids are left to the test.
function fillNight(s, t = T(s)) {
  for (const id of G.aliveIds(s)) {
    const k = task(s, id);
    if (k.done) continue;
    if (k.kind === 'decoy' || k.kind === 'seer' || k.kind === 'sorceress') act(s, id, { target: k.targets[0] }, t);
    else if (k.kind === 'meet') act(s, id, {}, t);
    else if (k.kind === 'witch' && !k.witch.waiting) act(s, id, { heal: null, poison: null }, t);
  }
}

// Fire deadlines until the predicate holds.
function runUntil(s, pred, limit = 50) {
  for (let i = 0; i < limit && !pred(s); i++) {
    const at = G.nextDeadline(s);
    if (at == null) break;
    G.onDeadline(s, at);
  }
  assert.ok(pred(s), 'condition not reached');
}
const toDay = (s) => runUntil(s, (x) => x.phase !== 'night');
const toStage = (s, stage) => runUntil(s, (x) => x.phase === 'day' && x.day.stage === stage);

// Play a night: the listed actions in order, the rest by fillNight, then on to dawn.
function playNight(s, actions = []) {
  assert.equal(s.phase, 'night');
  const t = T(s);
  for (const [id, payload] of actions) act(s, id, payload, t);
  fillNight(s, t);
  toDay(s);
}

// From discussion: start the vote, cast the votes, then end the vote.
function dayVote(s, votes) {
  if (s.day.stage === 'discussion') host(s, 'start-vote');
  const t = T(s);
  for (const [voter, target] of Object.entries(votes)) G.vote(s, voter, target, t);
  if (s.phase === 'day' && s.day.stage === 'vote') host(s, 'end-vote', t);
}

const nextNight = (s) => host(s, 'next-night');
const alive = (s, id) => s.players[id].alive;
const dead = (s, id) => !s.players[id].alive;
const snap = (s) => JSON.stringify(s);
const announcements = (s, id) => view(s, id).day.announcements;
const privateNews = (s, id) => announcements(s, id).filter((a) => a.kind === 'private').map((a) => a.text);

function throwsCode(fn, code) {
  assert.throws(fn, (e) => e instanceof G.GameError && e.code === code);
}

// A five-player village with one wolf, used by many tests.
const BASIC = { ana: 'werewolf', ben: 'seer', cal: 'doctor', dev: 'villager', eve: 'villager' };

// ---------------------------------------------------------------- setup

test('createGame deals the fixed roles, starts in reveal and round-trips through JSON', () => {
  const s = makeGame(BASIC);
  assert.equal(s.phase, 'reveal');
  assert.deepEqual(G.trueRoles(s), BASIC);
  assert.deepEqual(G.aliveIds(s), ['ana', 'ben', 'cal', 'dev', 'eve']);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  assert.equal(G.inGame(s, 'ana'), true);
  assert.equal(G.inGame(s, 'zed'), false);
  assert.equal(G.isOver(s), false);
  assert.equal(G.nextDeadline(s), G.TIMERS.revealMs);
});

test('dealing is deterministic for a seed and uses every card once', () => {
  const players = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => ({ id, name: id }));
  const roles = { werewolf: 2, seer: 1, witch: 1, hunter: 1, villager: 3 };
  const one = G.createGame({ players, roles, now: 0, rng: seeded(7) });
  const two = G.createGame({ players, roles, now: 0, rng: seeded(7) });
  assert.deepEqual(G.trueRoles(one), G.trueRoles(two));
  const counts = {};
  for (const r of Object.values(G.trueRoles(one))) counts[r] = (counts[r] || 0) + 1;
  assert.deepEqual(counts, roles);
});

test('setup validation: count, limits, killer wolf, Apprentice needs Seer, wolf team size', () => {
  const players = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  const bad = (roles, n = 5) => throwsCode(() => G.createGame({ players: players(n), roles, now: 0 }), 'BAD_SETTINGS');
  bad({ werewolf: 1, villager: 3 });                       // sums to 4, not 5
  bad({ werewolf: 1, villager: 5 });                       // sums to 6
  bad({ werewolf: 1, seer: 2, villager: 2 });              // at most one Seer
  bad({ werewolf: 1, mason: 1, villager: 3 });             // Masons come in twos or threes
  bad({ minion: 1, villager: 4 });                         // no killer wolf
  bad({ werewolf: 1, apprentice: 1, villager: 3 });        // Apprentice without a Seer
  bad({ werewolf: 2, minion: 1, villager: 3 }, 6);         // wolf team 3 of 6
  bad({ werewolf: 7, villager: 13 }, 20);                  // at most 6 Werewolves
  assert.ok(G.createGame({ players: players(5), roles: { werewolf: 1, mason: 2, villager: 2 }, now: 0 }));
  throwsCode(() => G.createGame({ players: players(5), roles: { werewolf: 1, villager: 4 }, settings: { reveal: 'x' }, now: 0 }), 'BAD_SETTINGS');
  // The test-only assign option can only hand out cards that are in the deck.
  throwsCode(() => G.createGame({ players: players(5), roles: { werewolf: 1, villager: 4 }, assign: { p0: 'seer' }, now: 0 }), 'BAD_SETTINGS');
});

test('role reveal: night 1 starts when everyone has tapped Got it', () => {
  const s = makeGame(BASIC);
  for (const id of ['ana', 'ben', 'cal', 'dev']) G.seenRole(s, id, 100);
  assert.equal(s.phase, 'reveal');
  assert.deepEqual(view(s, 'ana').reveal, { seen: ['ana', 'ben', 'cal', 'dev'], youSeen: true });
  assert.equal(view(s, 'eve').reveal.youSeen, false);
  G.seenRole(s, 'eve', 200);
  assert.equal(s.phase, 'night');
  assert.equal(s.round, 1);
  throwsCode(() => G.seenRole(s, 'eve', 300), 'NOT_ALLOWED');
});

test('timeouts: role reveal moves on by itself after 60 s, and the host can start night 1 early', () => {
  const s = makeGame(BASIC);
  G.seenRole(s, 'ana', 10);
  G.onDeadline(s, 59999);
  assert.equal(s.phase, 'reveal');
  G.onDeadline(s, 60000);
  assert.equal(s.phase, 'night');
  const h = makeGame(BASIC);
  assert.ok(view(h, 'ana', { isHost: true }).hostActions.includes('start-night'));
  host(h, 'start-night', 5);
  assert.equal(h.phase, 'night');
});

test('timeScale divides every timer', () => {
  const s = makeGame(BASIC, {}, { timeScale: 100 });
  assert.equal(G.nextDeadline(s), 600);
  G.onDeadline(s, 600);
  assert.equal(s.phase, 'night');
  assert.equal(s.deadlines.nightEnd, 600 + 900);
  assert.equal(s.deadlines.nightMin, 600 + 200);
  assert.equal(s.deadlines.packLock, 600 + 900 - 200);
});

// ---------------------------------------------------------------- Seer

test('Seer: the Lycan reads as a werewolf; Shadow Wolf, Minion and Sorceress read as not', () => {
  const roles = {
    ana: 'werewolf', ben: 'seer', cal: 'lycan', dev: 'shadowwolf', eve: 'minion',
    fay: 'sorceress', gus: 'villager', hal: 'villager', ivy: 'villager', jon: 'villager',
    kim: 'villager', lee: 'villager', may: 'wolfcub', ned: 'villager', oli: 'villager',
  };
  const expected = { ana: true, cal: true, dev: false, eve: false, fay: false, gus: false, may: true };
  for (const [target, wolf] of Object.entries(expected)) {
    const s = startGame(roles);
    const res = act(s, 'ben', { target });
    assert.equal(res.result.wolf, wolf, target);
    assert.equal(res.result.target, target);
    assert.match(res.result.text, wolf ? /is a werewolf/ : /is not a werewolf/);
    const v = view(s, 'ben');
    assert.equal(v.me.marks[target], wolf ? 'wolf' : 'notwolf');
    assert.equal(v.me.notes.length, 1);
    assert.deepEqual(v.night.task.result, res.result);
    assert.equal(v.night.task.done, true);
    assert.deepEqual(view(s, 'gus').me.marks, {});
    assert.deepEqual(view(s, 'gus').me.notes, []);
  }
});

test('Seer: can only inspect another living player, once a night', () => {
  const s = startGame(BASIC);
  throwsCode(() => act(s, 'ben', { target: 'ben' }), 'BAD_TARGET');
  throwsCode(() => act(s, 'ben', { target: 'zed' }), 'BAD_TARGET');
  throwsCode(() => act(s, 'ben', {}), 'BAD_REQUEST');
  const before = snap(s);
  throwsCode(() => act(s, 'ben', { target: 'ben' }), 'BAD_TARGET');
  assert.equal(snap(s), before, 'a rejected action leaves state unchanged');
  act(s, 'ben', { target: 'ana' });
  throwsCode(() => act(s, 'ben', { target: 'cal' }), 'NOT_ALLOWED');
});

// ---------------------------------------------------------------- Doctor

test('Doctor: protection stops the night kill', () => {
  const s = startGame(BASIC);
  playNight(s, [['ana', { target: 'dev' }], ['cal', { target: 'dev' }]]);
  assert.ok(alive(s, 'dev'));
  assert.deepEqual(announcements(s, 'eve').map((a) => a.kind), ['info']);
  assert.match(announcements(s, 'eve')[0].text, /Nobody died/);
});

test('Doctor: protection stops poison, and self-protection works', () => {
  const roles = { ana: 'werewolf', ben: 'witch', cal: 'doctor', dev: 'villager', eve: 'villager', fay: 'villager' };
  const s = startGame(roles);
  playNight(s, [['ana', { target: 'cal' }], ['cal', { target: 'cal' }], ['ben', { heal: null, poison: 'cal' }]]);
  assert.ok(alive(s, 'cal'), 'self-protection beats both the pack and the poison');
  assert.equal(s.witch.poisonUsed, true, 'the potion is spent anyway');
});

test('Doctor: the same player can\'t be protected two nights running', () => {
  const s = startGame({ ...BASIC, fay: 'villager' });
  playNight(s, [['ana', { target: 'eve' }], ['cal', { target: 'dev' }]]);
  dayVote(s, {});
  nextNight(s);
  assert.ok(!task(s, 'cal').targets.includes('dev'));
  assert.ok(task(s, 'cal').targets.includes('cal'));
  throwsCode(() => act(s, 'cal', { target: 'dev' }), 'BAD_TARGET');
  playNight(s, [['ana', { target: 'fay' }], ['cal', { target: 'cal' }]]);
  dayVote(s, {});
  nextNight(s);
  assert.ok(task(s, 'cal').targets.includes('dev'), 'allowed again after a night off');
});

// ---------------------------------------------------------------- Witch

const WITCHY = { ana: 'werewolf', ben: 'witch', cal: 'villager', dev: 'villager', eve: 'villager', fay: 'villager' };

test('Witch: waits for the pack, then sees the victim and heals them', () => {
  const s = startGame(WITCHY);
  const before = task(s, 'ben');
  assert.equal(before.witch.waiting, true);
  assert.deepEqual(before.witch.victims, []);
  throwsCode(() => act(s, 'ben', { heal: null, poison: null }), 'NOT_ALLOWED');
  act(s, 'ana', { target: 'dev' });
  const open = task(s, 'ben');
  assert.deepEqual(open.witch, { waiting: false, victims: ['dev'], canHeal: true, canPoison: true });
  throwsCode(() => act(s, 'ben', { heal: 'cal', poison: null }), 'BAD_TARGET');
  playNight(s, [['ben', { heal: 'dev', poison: null }]]);
  assert.ok(alive(s, 'dev'));
  assert.equal(s.witch.healUsed, true);
});

test('Witch: may heal herself; poison kills anyone but herself', () => {
  const s = startGame(WITCHY);
  act(s, 'ana', { target: 'ben' });
  throwsCode(() => act(s, 'ben', { heal: null, poison: 'ben' }), 'BAD_TARGET');
  throwsCode(() => act(s, 'ben', { heal: null, poison: 'zed' }), 'BAD_TARGET');
  assert.ok(!task(s, 'ben').targets.includes('ben'));
  playNight(s, [['ben', { heal: 'ben', poison: 'cal' }]]);
  assert.ok(alive(s, 'ben'), 'healed herself');
  assert.ok(dead(s, 'cal'), 'poisoned, using both potions in one night');
  assert.equal(s.players.cal.cause, 'poison');
  assert.equal(view(s, 'dev').players.find((p) => p.id === 'cal').cause, 'night', 'poison shows as a night death');
});

test('Witch: each potion works once, and she sees victims only while the heal is unused', () => {
  const s = startGame(WITCHY);
  playNight(s, [['ana', { target: 'dev' }], ['ben', { heal: 'dev', poison: null }]]);
  dayVote(s, {});
  nextNight(s);
  act(s, 'ana', { target: 'cal' });
  const t2 = task(s, 'ben');
  assert.equal(t2.kind, 'witch');
  assert.deepEqual(t2.witch, { waiting: false, victims: [], canHeal: false, canPoison: true });
  throwsCode(() => act(s, 'ben', { heal: 'cal', poison: null }), 'BAD_TARGET');
  playNight(s, [['ben', { heal: null, poison: 'eve' }]]);
  assert.ok(dead(s, 'cal') && dead(s, 'eve'));
  dayVote(s, {});
  nextNight(s);
  assert.equal(task(s, 'ben').kind, 'decoy', 'no potion left: a decoy task');
});

test('Witch: with no kill tonight her task opens at once', () => {
  const s = startGame(WITCHY, { firstNightKill: false });
  assert.equal(task(s, 'ana').kind, 'meet');
  const w = task(s, 'ben');
  assert.equal(w.witch.waiting, false);
  assert.deepEqual(w.witch.victims, []);
  assert.equal(w.witch.canHeal, false);
  act(s, 'ben', { heal: null, poison: 'cal' });
  playNight(s);
  assert.ok(dead(s, 'cal'), 'poison works from night 1');
});

// ---------------------------------------------------------------- Witch timing and the pack

const PACK = { ana: 'werewolf', bob: 'werewolf', ben: 'witch', cal: 'villager', dev: 'villager', eve: 'villager', fay: 'villager', gus: 'villager' };

test('Pack choice: locks only when all living killer wolves agree', () => {
  const s = startGame(PACK);
  act(s, 'ana', { target: 'cal' }, 1000);
  act(s, 'bob', { target: 'dev' }, 1000);
  assert.equal(task(s, 'ana').done, false);
  assert.deepEqual(task(s, 'ana').wolf.picks, { ana: 'cal', bob: 'dev' });
  assert.deepEqual(task(s, 'bob').wolf.picks, { ana: 'cal', bob: 'dev' });
  assert.equal(task(s, 'ben').witch.waiting, true);
  assert.equal(task(s, 'cal').wolf, undefined, 'only wolves see pack picks');
  act(s, 'ana', { target: 'dev' }, 2000);
  assert.equal(task(s, 'ana').done, true);
  assert.deepEqual(task(s, 'ana').wolf.locked, ['dev']);
  throwsCode(() => act(s, 'ana', { target: 'cal' }, 2500), 'NOT_ALLOWED');
  assert.equal(task(s, 'ben').witch.waiting, false);
  assert.deepEqual(task(s, 'ben').witch.victims, ['dev']);
  throwsCode(() => act(s, 'ana', { target: 'bob' }), 'NOT_ALLOWED');
});

test('Pack choice: wolves can\'t pick a killer wolf; they can pick the Minion and Sorceress', () => {
  const s = startGame({ ...PACK, fay: 'minion', gus: 'sorceress', hal: 'villager', ivy: 'villager' });
  throwsCode(() => act(s, 'ana', { target: 'bob' }), 'BAD_TARGET');
  throwsCode(() => act(s, 'ana', { target: 'ana' }), 'BAD_TARGET');
  assert.ok(task(s, 'ana').targets.includes('fay') && task(s, 'ana').targets.includes('gus'));
  act(s, 'ana', { target: 'fay' });
});

test('Witch timing: the plurality pick locks 20 s before the deadline, with a seeded tie-break', () => {
  const picks = new Set();
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const s = startGame(PACK, {}, { seed });
    act(s, 'ana', { target: 'cal' }, 1000);
    act(s, 'bob', { target: 'dev' }, 1000);
    fillNight(s, 1000);
    G.onDeadline(s, 69999);
    assert.equal(task(s, 'ana').done, false);
    assert.equal(G.nextDeadline(s), 70000);
    G.onDeadline(s, 70000);
    const locked = task(s, 'ana').wolf.locked;
    assert.equal(locked.length, 1);
    assert.ok(['cal', 'dev'].includes(locked[0]));
    picks.add(locked[0]);
    assert.equal(task(s, 'ben').witch.waiting, false);
    assert.equal(s.deadlines.nightEnd, 90000, 'the witch already has 20 s');
    // Same seed, same actions: same tie-break.
    const again = startGame(PACK, {}, { seed });
    act(again, 'ana', { target: 'cal' }, 1000);
    act(again, 'bob', { target: 'dev' }, 1000);
    fillNight(again, 1000);
    G.onDeadline(again, 70000);
    assert.deepEqual(task(again, 'ana').wolf.locked, locked);
  }
  assert.equal(picks.size, 2, 'both tied picks win under some seed');
});

test('Pack choice: the plurality beats a lone dissenter; no picks means no kill', () => {
  const s = startGame({ ...PACK, hal: 'werewolf', ivy: 'villager', jon: 'villager' });
  act(s, 'ana', { target: 'cal' }, 1000);
  act(s, 'bob', { target: 'cal' }, 1000);
  act(s, 'hal', { target: 'dev' }, 1000);
  G.onDeadline(s, 70000);
  assert.deepEqual(task(s, 'ana').wolf.locked, ['cal']);
  const quiet = startGame(PACK);
  fillNight(quiet, 1000);
  G.onDeadline(quiet, 70000);
  assert.deepEqual(task(quiet, 'ana').wolf.locked, []);
  assert.equal(task(quiet, 'ana').done, true);
  act(quiet, 'ben', { heal: null, poison: null }, 71000);
  assert.equal(quiet.phase, 'day');
  assert.equal(G.aliveIds(quiet).length, 8);
});

test('Witch timing: the Witch always gets at least 20 s after the lock, even if the server is late', () => {
  const s = startGame(PACK);
  fillNight(s, 1000);
  act(s, 'ana', { target: 'cal' }, 1000);
  // The server only wakes up at the night deadline: the forced lock happens now,
  // and the night is pushed out so the Witch still gets her 20 seconds.
  G.onDeadline(s, 90000);
  assert.equal(s.phase, 'night');
  assert.deepEqual(task(s, 'ben').witch.victims, ['cal']);
  assert.equal(G.nextDeadline(s), 110000);
  assert.equal(view(s, 'cal').deadline.endsAt, 110000);
  G.onDeadline(s, 109999);
  assert.equal(s.phase, 'night');
  act(s, 'ben', { heal: 'cal', poison: null }, 100000);
  assert.equal(s.phase, 'day', 'everyone done and past the minimum');
  assert.ok(alive(s, 'cal'));
});

test('Witch timing: after the pack locks, the night waits for the Witch until the deadline', () => {
  const s = startGame(PACK);
  fillNight(s, 1000);
  act(s, 'ana', { target: 'cal' }, 1000);
  act(s, 'bob', { target: 'cal' }, 1000);
  G.onDeadline(s, 20000);
  assert.equal(s.phase, 'night', 'the Witch has not acted');
  G.onDeadline(s, 90000);
  assert.equal(s.phase, 'day');
  assert.ok(dead(s, 'cal'), 'unfinished tasks are skipped');
});

// ---------------------------------------------------------------- Elder

const ELDERLY = { ana: 'werewolf', ben: 'elder', cal: 'doctor', dev: 'witch', eve: 'villager', fay: 'villager', gus: 'villager' };

test('Elder: survives the first werewolf attack (and is told), dies on the second', () => {
  const s = startGame(ELDERLY);
  playNight(s, [['ana', { target: 'ben' }]]);
  assert.ok(alive(s, 'ben'));
  assert.equal(privateNews(s, 'ben').length, 1);
  assert.match(privateNews(s, 'ben')[0], /survived/);
  assert.deepEqual(privateNews(s, 'eve'), []);
  assert.equal(view(s, 'ben').me.notes.length, 1);
  dayVote(s, {});
  nextNight(s);
  playNight(s, [['ana', { target: 'ben' }]]);
  assert.ok(dead(s, 'ben'));
});

test('Elder: a Doctor-protected Elder keeps the extra life', () => {
  const s = startGame(ELDERLY);
  playNight(s, [['ana', { target: 'ben' }], ['cal', { target: 'ben' }]]);
  assert.ok(alive(s, 'ben'));
  assert.equal(s.players.ben.flags.elderLife, true);
  assert.deepEqual(privateNews(s, 'ben'), []);
});

test('Elder: poison and the vote kill outright', () => {
  const p = startGame(ELDERLY);
  playNight(p, [['ana', { target: 'eve' }], ['dev', { heal: null, poison: 'ben' }]]);
  assert.ok(dead(p, 'ben'));
  const v = startGame(ELDERLY);
  playNight(v, [['ana', { target: 'eve' }]]);
  dayVote(v, { ana: 'ben', cal: 'ben', dev: 'ben', fay: 'ben' });
  assert.ok(dead(v, 'ben'));
  assert.equal(v.day.verdict.outcome, 'eliminated');
});

// ---------------------------------------------------------------- Lovers

const CUPID = { ana: 'werewolf', ben: 'cupid', cal: 'villager', dev: 'villager', eve: 'villager', fay: 'villager' };

test('Lovers: they learn their partner and whether they share a team, never the role', () => {
  const s = startGame(CUPID);
  assert.equal(task(s, 'ben').kind, 'cupid');
  assert.equal(task(s, 'ben').choose, 2);
  throwsCode(() => act(s, 'ben', { targets: ['ana', 'ana'] }), 'BAD_TARGET');
  throwsCode(() => act(s, 'ben', { targets: ['ana'] }), 'BAD_REQUEST');
  playNight(s, [['ben', { targets: ['ana', 'cal'] }], ['ana', { target: 'dev' }]]);
  assert.deepEqual(view(s, 'ana').me.knows.lover, { id: 'cal', sameTeam: false });
  assert.deepEqual(view(s, 'cal').me.knows.lover, { id: 'ana', sameTeam: false });
  assert.equal(view(s, 'ben').me.knows.lover, null);
  assert.equal(privateNews(s, 'ana').length, 1);
  assert.match(privateNews(s, 'cal')[0], /in love with Ana.*different teams/);
  assert.deepEqual(privateNews(s, 'ben'), []);
  assert.equal(view(s, 'cal').players.find((p) => p.id === 'ana').role, null);
  const same = startGame(CUPID);
  playNight(same, [['ben', { targets: ['ben', 'cal'] }], ['ana', { target: 'dev' }]]);
  assert.deepEqual(view(same, 'ben').me.knows.lover, { id: 'cal', sameTeam: true });
});

test('Lovers: a wolf can\'t target their own lover', () => {
  const s = startGame(CUPID);
  playNight(s, [['ben', { targets: ['ana', 'cal'] }], ['ana', { target: 'dev' }]]);
  dayVote(s, {});
  nextNight(s);
  assert.ok(!task(s, 'ana').targets.includes('cal'));
  throwsCode(() => act(s, 'ana', { target: 'cal' }), 'BAD_TARGET');
});

test('Lovers: a lover\'s death kills the partner at once, whatever the cause', () => {
  // Werewolves.
  const w = startGame(CUPID);
  playNight(w, [['ben', { targets: ['cal', 'dev'] }], ['ana', { target: 'cal' }]]);
  assert.ok(dead(w, 'cal') && dead(w, 'dev'));
  assert.equal(w.players.dev.cause, 'heartbreak');
  assert.ok(announcements(w, 'eve').some((a) => a.playerId === 'dev' && /broken heart/.test(a.text)));
  assert.equal(view(w, 'eve').players.find((p) => p.id === 'dev').cause, 'heartbreak');
  // The vote.
  const v = startGame(CUPID);
  playNight(v, [['ben', { targets: ['cal', 'dev'] }], ['ana', { target: 'fay' }]]);
  dayVote(v, { ana: 'cal', ben: 'cal', eve: 'cal' });
  assert.ok(dead(v, 'cal') && dead(v, 'dev'));
  assert.equal(v.players.dev.diedPhase, 'day');
  // Poison.
  const p = startGame({ ...CUPID, fay: 'witch' });
  playNight(p, [['ben', { targets: ['cal', 'dev'] }], ['ana', { target: 'eve' }], ['fay', { heal: null, poison: 'dev' }]]);
  assert.ok(dead(p, 'cal') && dead(p, 'dev') && dead(p, 'eve'));
  assert.equal(p.players.cal.cause, 'heartbreak');
});

test('Lovers: opposite-team lovers win as the last two alive', () => {
  const s = startGame({ ana: 'werewolf', ben: 'cupid', cal: 'villager', dev: 'villager', eve: 'villager' });
  playNight(s, [['ben', { targets: ['ana', 'cal'] }], ['ana', { target: 'ben' }]]);
  dayVote(s, { ana: 'dev', cal: 'dev', eve: 'dev' });
  assert.equal(s.phase, 'day');
  nextNight(s);
  playNight(s, [['ana', { target: 'eve' }]]);
  assert.equal(s.phase, 'over');
  assert.equal(s.winner.team, 'lovers');
  assert.deepEqual(s.winner.winners, ['ana', 'cal']);
});

test('Lovers: an opposite-team lover never counts toward wolf parity', () => {
  const s = startGame({ ana: 'werewolf', bob: 'werewolf', ben: 'cupid', cal: 'villager', dev: 'villager', eve: 'villager', fay: 'villager' });
  playNight(s, [['ben', { targets: ['ana', 'cal'] }], ['ana', { target: 'ben' }], ['bob', { target: 'ben' }]]);
  dayVote(s, { ana: 'dev', bob: 'dev', cal: 'dev', eve: 'dev', fay: 'dev' });
  nextNight(s);
  playNight(s, [['ana', { target: 'eve' }], ['bob', { target: 'eve' }]]);
  // Alive: ana (wolf, lover), bob (wolf), cal (lover), fay. Two wolves against two, but ana counts with the village.
  assert.deepEqual(G.aliveIds(s), ['ana', 'bob', 'cal', 'fay']);
  assert.equal(s.phase, 'day');
  assert.equal(s.winner, null);
});

test('Lovers\' vote: a Lover\'s vote for their partner is rejected', () => {
  const s = startGame(CUPID);
  playNight(s, [['ben', { targets: ['cal', 'dev'] }], ['ana', { target: 'fay' }]]);
  host(s, 'start-vote');
  assert.deepEqual(view(s, 'cal').day.vote.blocked, ['dev']);
  assert.deepEqual(view(s, 'eve').day.vote.blocked, []);
  const before = snap(s);
  throwsCode(() => G.vote(s, 'cal', 'dev', T(s)), 'BAD_TARGET');
  assert.equal(snap(s), before);
  G.vote(s, 'cal', 'eve', T(s));
  assert.equal(view(s, 'cal').day.vote.myVote, 'eve');
});

// ---------------------------------------------------------------- Hunter

const HUNTER = { ana: 'werewolf', ben: 'hunter', cal: 'villager', dev: 'villager', eve: 'villager', fay: 'villager' };

test('Hunter: shoots after a night death, then discussion starts', () => {
  const s = startGame(HUNTER);
  playNight(s, [['ana', { target: 'ben' }]]);
  assert.equal(s.day.stage, 'shot');
  const hv = view(s, 'ben');
  assert.equal(hv.day.shooter, 'ben');
  assert.deepEqual(hv.day.shot.targets, ['ana', 'cal', 'dev', 'eve', 'fay']);
  assert.equal(view(s, 'cal').day.shot, null);
  assert.equal(view(s, 'cal').day.shooter, 'ben');
  throwsCode(() => G.shoot(s, 'cal', 'dev', T(s)), 'NOT_ALLOWED');
  throwsCode(() => G.shoot(s, 'ben', 'ben', T(s)), 'BAD_TARGET');
  G.shoot(s, 'ben', 'cal', T(s));
  assert.ok(dead(s, 'cal'));
  assert.equal(s.players.cal.cause, 'hunter');
  assert.equal(s.day.stage, 'discussion');
  assert.equal(view(s, 'dev', {}).players.find((p) => p.id === 'ben').role, 'hunter');
  throwsCode(() => G.shoot(s, 'ben', 'dev', T(s)), 'NOT_ALLOWED');
});

test('Hunter: shoots after a vote, then the verdict resumes; the shot can trigger a lover\'s death', () => {
  const s = startGame({ ...HUNTER, gus: 'cupid' });
  playNight(s, [['gus', { targets: ['cal', 'dev'] }], ['ana', { target: 'eve' }]]);
  dayVote(s, { ana: 'ben', cal: 'ben', dev: 'ben', fay: 'ben' });
  assert.equal(s.day.stage, 'shot');
  assert.equal(view(s, 'fay').day.verdict.eliminated, 'ben');
  G.shoot(s, 'ben', 'cal', T(s));
  assert.ok(dead(s, 'cal') && dead(s, 'dev'));
  assert.equal(s.players.dev.cause, 'heartbreak');
  assert.equal(s.day.stage, 'verdict');
});

test('Hunter: no shot once the Village has won', () => {
  const s = startGame({ ...HUNTER, fay: 'witch' });
  act(s, 'ana', { target: 'ben' });
  playNight(s, [['fay', { heal: null, poison: 'ana' }]]);
  assert.ok(dead(s, 'ana') && dead(s, 'ben'));
  assert.equal(s.phase, 'over');
  assert.equal(s.winner.team, 'village');
  assert.deepEqual(s.pendingShots, []);
});

test('Hunter: the shot comes before a wolf win at parity', () => {
  const s = startGame({ ana: 'werewolf', ben: 'hunter', cal: 'villager', dev: 'villager', eve: 'villager' });
  playNight(s, [['ana', { target: 'cal' }]]);
  dayVote(s, { ana: 'ben', dev: 'ben', eve: 'ben' });
  // Alive: ana, dev, eve. The Hunter's shot is taken before the check runs again.
  assert.equal(s.day.stage, 'shot');
  G.shoot(s, 'ben', 'ana', T(s));
  assert.equal(s.phase, 'over');
  assert.equal(s.winner.team, 'village');
});

test('Hunter: no pick within 30 s means no shot; the host can skip only while the Hunter is offline', () => {
  const s = startGame(HUNTER);
  playNight(s, [['ana', { target: 'ben' }]]);
  const start = s.deadlines.shot - G.TIMERS.shotMs;
  const online = { isHost: true, isOnline: () => true };
  const offline = { isHost: true, isOnline: (id) => id !== 'ben' };
  assert.ok(!view(s, 'cal', online).hostActions.includes('skip-shot'));
  throwsCode(() => host(s, 'skip-shot', start + 1000, online), 'NOT_ALLOWED');
  assert.ok(view(s, 'cal', offline).hostActions.includes('skip-shot'));
  G.onDeadline(s, start + 29999);
  assert.equal(s.day.stage, 'shot');
  G.onDeadline(s, start + 30000);
  assert.equal(s.day.stage, 'discussion');
  assert.equal(G.aliveIds(s).length, 5);
  assert.equal(view(s, 'cal').players.find((p) => p.id === 'ben').role, 'hunter', 'reveal "role" shows the dead Hunter');
  const k = startGame(HUNTER, { reveal: 'none' });
  playNight(k, [['ana', { target: 'ben' }]]);
  host(k, 'skip-shot', T(k), offline);
  assert.equal(k.day.stage, 'discussion');
  assert.equal(view(k, 'cal').players.find((p) => p.id === 'ben').role, null, 'no shot, no role shown');
});

// ---------------------------------------------------------------- Wolf Cub

test('Wolf Cub: its death gives the pack two different victims the following night', () => {
  const s = startGame({ ana: 'wolfcub', bob: 'werewolf', cal: 'villager', dev: 'villager', eve: 'villager', fay: 'villager', gus: 'villager', hal: 'villager' });
  playNight(s, [['ana', { target: 'hal' }], ['bob', { target: 'hal' }]]);
  dayVote(s, { bob: 'ana', cal: 'ana', dev: 'ana', eve: 'ana' });
  assert.ok(dead(s, 'ana'));
  nextNight(s);
  assert.deepEqual(task(s, 'bob').wolf, { slot: 1, slots: 2, picks: {}, locked: [] });
  act(s, 'bob', { target: 'cal' });
  assert.equal(task(s, 'bob').done, false);
  assert.equal(task(s, 'bob').wolf.slot, 2);
  assert.ok(!task(s, 'bob').targets.includes('cal'));
  throwsCode(() => act(s, 'bob', { target: 'cal' }), 'BAD_TARGET');
  playNight(s, [['bob', { target: 'dev' }]]);
  assert.ok(dead(s, 'cal') && dead(s, 'dev'));
  dayVote(s, {});
  nextNight(s);
  assert.equal(task(s, 'bob').wolf.slots, 1, 'only the night after');
});

// ---------------------------------------------------------------- Apprentice Seer

test('Apprentice Seer: gains the check from the night after the Seer dies; the Sorceress then finds them', () => {
  const s = startGame({ ana: 'werewolf', ben: 'seer', cal: 'apprentice', dev: 'sorceress', eve: 'villager', fay: 'villager', gus: 'villager', hal: 'villager' });
  assert.equal(task(s, 'cal').kind, 'decoy');
  assert.equal(act(s, 'dev', { target: 'cal' }).result.seer, false);
  playNight(s, [['ana', { target: 'ben' }]]);
  assert.ok(dead(s, 'ben'));
  assert.equal(privateNews(s, 'cal').length, 1);
  assert.match(privateNews(s, 'cal')[0], /Seer is dead/);
  assert.deepEqual(privateNews(s, 'eve'), []);
  dayVote(s, {});
  nextNight(s);
  assert.equal(task(s, 'cal').kind, 'seer');
  assert.equal(act(s, 'cal', { target: 'ana' }).result.wolf, true);
  assert.equal(view(s, 'cal').me.marks.ana, 'wolf');
  const found = act(s, 'dev', { target: 'cal' }).result;
  assert.equal(found.seer, true);
  assert.equal(view(s, 'dev').me.marks.cal, 'seer');
});

test('Sorceress: finds the Seer, and only the Seer', () => {
  const s = startGame({ ana: 'werewolf', ben: 'seer', dev: 'sorceress', eve: 'villager', fay: 'villager', gus: 'villager', hal: 'villager' });
  assert.equal(act(s, 'dev', { target: 'ben' }).result.seer, true);
  const t = startGame({ ana: 'werewolf', ben: 'seer', dev: 'sorceress', eve: 'villager', fay: 'villager', gus: 'villager', hal: 'villager' });
  const r = act(t, 'dev', { target: 'eve' }).result;
  assert.equal(r.seer, false);
  assert.match(r.text, /is not the Seer/);
  throwsCode(() => act(t, 'dev', { target: 'dev' }), 'NOT_ALLOWED');
});

// ---------------------------------------------------------------- Prince and Jester

test('Prince: survives the first vote against them and is revealed; a second vote eliminates them', () => {
  const s = startGame({ ana: 'werewolf', ben: 'prince', cal: 'villager', dev: 'villager', eve: 'villager', fay: 'villager', gus: 'villager' });
  playNight(s, [['ana', { target: 'gus' }]]);
  assert.equal(view(s, 'cal').players.find((p) => p.id === 'ben').role, null);
  dayVote(s, { ana: 'ben', cal: 'ben', dev: 'ben' });
  assert.ok(alive(s, 'ben'));
  assert.equal(s.day.verdict.outcome, 'prince');
  assert.equal(view(s, 'cal').players.find((p) => p.id === 'ben').role, 'prince');
  assert.equal(view(s, 'zed').players.find((p) => p.id === 'ben').role, 'prince', 'public');
  nextNight(s);
  playNight(s, [['ana', { target: 'fay' }]]);
  dayVote(s, { ana: 'ben', cal: 'ben', dev: 'ben' });
  assert.ok(dead(s, 'ben'));
  assert.equal(s.day.verdict.outcome, 'eliminated');
});

const JESTER = { ana: 'werewolf', ben: 'jester', cal: 'villager', dev: 'villager', eve: 'villager', fay: 'cupid' };

test('Jester: wins at once if voted out, even as a Lover', () => {
  const s = startGame(JESTER);
  playNight(s, [['fay', { targets: ['ben', 'cal'] }], ['ana', { target: 'dev' }]]);
  dayVote(s, { ana: 'ben', eve: 'ben', fay: 'ben' });
  assert.equal(s.phase, 'over');
  assert.equal(s.winner.team, 'jester');
  assert.deepEqual(s.winner.winners, ['ben']);
  assert.ok(dead(s, 'cal'), 'the partner still dies of a broken heart');
});

test('Jester: no win if killed at night', () => {
  const s = startGame(JESTER);
  playNight(s, [['ana', { target: 'ben' }]]);
  assert.ok(dead(s, 'ben'));
  assert.equal(s.phase, 'day');
  assert.equal(s.winner, null);
});

// ---------------------------------------------------------------- Voting

const SEVEN = { ana: 'werewolf', ben: 'villager', cal: 'villager', dev: 'villager', eve: 'villager', fay: 'villager', gus: 'villager' };

function dayOne(settings) {
  const s = startGame(SEVEN, settings);
  playNight(s, [['ana', { target: 'gus' }]]);
  host(s, 'start-vote');
  return s;
}

test('Voting: plurality eliminates; every vote is shown by name at the verdict', () => {
  const s = dayOne();
  dayVote(s, { ana: 'ben', cal: 'ben', dev: 'ben', ben: 'cal', eve: 'skip' });
  assert.ok(dead(s, 'ben'));
  const v = view(s, 'fay').day.verdict;
  assert.equal(v.outcome, 'eliminated');
  assert.equal(v.eliminated, 'ben');
  assert.deepEqual(v.votes, { ana: 'ben', ben: 'cal', cal: 'ben', dev: 'ben', eve: 'skip' });
  assert.deepEqual(v.tally, { ben: 3, cal: 1, skip: 1 });
  assert.equal(view(s, 'fay').day.stage, 'verdict');
});

test('Voting: a tie, or Skip on top (alone or tied), eliminates nobody', () => {
  const tie = dayOne();
  dayVote(tie, { ana: 'ben', cal: 'ben', ben: 'cal', dev: 'cal' });
  assert.equal(tie.day.verdict.outcome, 'tie');
  assert.equal(G.aliveIds(tie).length, 6);
  const skip = dayOne();
  dayVote(skip, { ana: 'skip', cal: 'skip', ben: 'cal' });
  assert.equal(skip.day.verdict.outcome, 'skip');
  const tied = dayOne();
  dayVote(tied, { ana: 'skip', cal: 'skip', ben: 'cal', dev: 'cal' });
  assert.equal(tied.day.verdict.outcome, 'tie'); // Skip tied for most is reported as a tie
  assert.match(tied.day.verdict.text, /tie/);
  assert.equal(G.aliveIds(tied).length, 6);
  const none = dayOne();
  dayVote(none, {});
  assert.equal(none.day.verdict.outcome, 'none');
});

test('Voting: rules for who may vote for whom; votes change until voting closes', () => {
  const s = startGame(SEVEN);
  playNight(s, [['ana', { target: 'gus' }]]);
  throwsCode(() => G.vote(s, 'ben', 'cal', T(s)), 'NOT_ALLOWED');   // nobody votes during discussion
  host(s, 'start-vote');
  throwsCode(() => G.vote(s, 'gus', 'cal', T(s)), 'NOT_ALLOWED');   // the dead don't vote
  throwsCode(() => G.vote(s, 'ben', 'ben', T(s)), 'BAD_TARGET');
  throwsCode(() => G.vote(s, 'ben', 'gus', T(s)), 'BAD_TARGET');
  throwsCode(() => G.vote(s, 'ben', 42, T(s)), 'BAD_REQUEST');
  G.vote(s, 'ben', 'cal', T(s));
  G.vote(s, 'ben', 'ana', T(s));
  const v = view(s, 'cal').day.vote;
  assert.deepEqual(v.voted, ['ben']);
  assert.equal(v.live, null, 'secret ballot');
  assert.equal(v.myVote, null);
  assert.equal(v.canVote, true);
  assert.equal(view(s, 'ben').day.vote.myVote, 'ana');
  assert.equal(view(s, 'gus').day.vote.canVote, false);
  G.vote(s, 'ana', 'cal', T(s));
  for (const id of ['cal', 'dev', 'eve']) G.vote(s, id, 'ana', T(s));
  assert.equal(s.day.stage, 'vote');
  G.vote(s, 'fay', 'skip', T(s));
  assert.equal(s.phase, 'over', 'closes when everyone has voted');
  assert.equal(s.winner.team, 'village');
});

test('Voting: live voting shows each vote as it is cast', () => {
  const s = dayOne({ voteStyle: 'live' });
  G.vote(s, 'ben', 'cal', T(s));
  assert.deepEqual(view(s, 'dev').day.vote.live, { ben: 'cal' });
});

test('Timeouts: the vote timer closes voting (missing votes abstain), and the verdict moves on after 20 s', () => {
  const s = startGame(SEVEN);
  playNight(s, [['ana', { target: 'gus' }]]);
  toStage(s, 'vote');
  G.vote(s, 'ben', 'cal', T(s));
  const closeAt = G.nextDeadline(s);
  G.onDeadline(s, closeAt);
  assert.equal(s.day.stage, 'verdict');
  assert.deepEqual(s.day.verdict.votes, { ben: 'cal' });
  assert.ok(dead(s, 'cal'));
  assert.equal(G.nextDeadline(s), closeAt + G.TIMERS.verdictMs);
  G.onDeadline(s, closeAt + G.TIMERS.verdictMs - 1);
  assert.equal(s.phase, 'day');
  G.onDeadline(s, closeAt + G.TIMERS.verdictMs);
  assert.equal(s.phase, 'night');
  assert.equal(s.round, 2);
});

test('Discussion: the timer starts the vote; with discussionSeconds 0 only the host does', () => {
  const s = startGame(SEVEN);
  playNight(s, [['ana', { target: 'gus' }]]);
  const start = s.deadlines.discussion - 180000;
  G.onDeadline(s, start + 180000);
  assert.equal(s.day.stage, 'vote');
  const h = startGame(SEVEN, { discussionSeconds: 0 });
  playNight(h, [['ana', { target: 'gus' }]]);
  assert.equal(G.nextDeadline(h), null);
  assert.equal(view(h, 'ben').deadline, null);
  assert.deepEqual(view(h, 'ben', { isHost: true }).hostActions, ['start-vote']);
  host(h, 'start-vote', 500000);
  assert.equal(h.day.stage, 'vote');
});

// ---------------------------------------------------------------- Win checks

test('Win checks: the wolves win at parity; winners are the whole team, dead or alive', () => {
  const s = startGame({ ana: 'werewolf', ben: 'minion', cal: 'villager', dev: 'villager', eve: 'villager', fay: 'villager', gus: 'villager' });
  playNight(s, [['ana', { target: 'cal' }]]);
  dayVote(s, { ana: 'dev', ben: 'dev', eve: 'dev' });
  nextNight(s);
  playNight(s, [['ana', { target: 'eve' }]]);
  // Alive: ana, ben (Minion), fay, gus: two against two.
  assert.equal(s.phase, 'over');
  assert.equal(s.winner.team, 'wolves');
  assert.deepEqual(s.winner.winners, ['ana', 'ben']);
});

test('Win checks: the village wins when no killer wolf is alive; a Minion alone can\'t keep the wolves alive', () => {
  // Six players: with five, a Werewolf plus a Minion would already be too many wolves.
  const s = startGame({ ana: 'werewolf', ben: 'minion', cal: 'witch', dev: 'villager', eve: 'cupid', fay: 'villager' });
  playNight(s, [['eve', { targets: ['cal', 'dev'] }], ['ana', { target: 'cal' }], ['cal', { heal: null, poison: 'ana' }]]);
  // Alive: the Minion, Cupid and a villager. The Minion is still on the board, but no killer wolf.
  assert.deepEqual(G.aliveIds(s), ['ben', 'eve', 'fay']);
  assert.equal(s.winner.team, 'village');
  assert.deepEqual(s.winner.winners, ['cal', 'dev', 'eve', 'fay']);
});

test('Win checks: nobody left alive is a Village win', () => {
  const s = startGame({ ana: 'werewolf', ben: 'witch', cal: 'villager', dev: 'villager', eve: 'cupid' });
  playNight(s, [['eve', { targets: ['ben', 'cal'] }], ['ana', { target: 'dev' }]]);
  dayVote(s, { ana: 'eve', ben: 'eve', cal: 'eve' });
  nextNight(s);
  playNight(s, [['ana', { target: 'cal' }], ['ben', { heal: null, poison: 'ana' }]]);
  assert.deepEqual(G.aliveIds(s), []);
  assert.equal(s.winner.team, 'village');
  assert.match(s.winner.text, /Nobody is left alive/);
});

// ---------------------------------------------------------------- Reveal modes

const REVEALS = { ana: 'werewolf', ben: 'seer', cal: 'lycan', dev: 'villager', eve: 'villager', fay: 'villager', gus: 'villager' };

function revealGame(reveal) {
  const s = startGame(REVEALS, { reveal });
  playNight(s, [['ana', { target: 'ben' }]]);        // a night death: the Seer
  dayVote(s, { ana: 'cal', dev: 'cal', eve: 'cal' }); // a day death: the Lycan
  return s;
}
const seen = (s, viewer, id) => {
  const p = view(s, viewer).players.find((x) => x.id === id);
  return { role: p.role, revealed: p.revealed };
};

test('Reveal modes: each mode shows exactly what it promises, and everything at game over', () => {
  const expect = {
    role: [{ kind: 'role', value: 'seer' }, { kind: 'role', value: 'lycan' }],
    day: [null, { kind: 'role', value: 'lycan' }],
    team: [{ kind: 'team', value: 'village' }, { kind: 'team', value: 'village' }],
    wolf: [{ kind: 'wolf', value: false }, { kind: 'wolf', value: false }],
    none: [null, null],
  };
  for (const [mode, [night, day]] of Object.entries(expect)) {
    const s = revealGame(mode);
    for (const viewer of ['dev', 'zed']) {
      assert.deepEqual(seen(s, viewer, 'ben'), { role: night && night.kind === 'role' ? 'seer' : null, revealed: night }, `${mode} night`);
      assert.deepEqual(seen(s, viewer, 'cal'), { role: day && day.kind === 'role' ? 'lycan' : null, revealed: day }, `${mode} day`);
    }
    const nightText = announcements(s, 'dev').find((a) => a.playerId === 'ben').text;
    if (!night) assert.doesNotMatch(nightText, /They were/);
    nextNight(s);
    playNight(s, [['ana', { target: 'gus' }]]);
    dayVote(s, { dev: 'ana', eve: 'ana', fay: 'ana' });
    assert.equal(s.phase, 'over', mode);
    for (const viewer of ['dev', 'zed']) {
      const v = view(s, viewer);
      for (const p of v.players) {
        assert.equal(p.role, REVEALS[p.id], `${mode}: every role at game over`);
        if (!p.alive) assert.deepEqual(p.revealed, { kind: 'role', value: REVEALS[p.id] });
      }
    }
    assert.equal(view(s, 'dev').players.find((p) => p.id === 'gus').cause, 'wolves', 'true causes at game over');
  }
});

test('Reveal modes: "wolf" is the true identity (Shadow Wolf yes; Lycan and Minion no)', () => {
  const s = startGame({ ana: 'shadowwolf', bob: 'werewolf', cal: 'minion', dev: 'lycan', eve: 'villager', fay: 'villager', gus: 'villager', hal: 'villager', ivy: 'villager' }, { reveal: 'wolf' });
  playNight(s, [['ana', { target: 'dev' }], ['bob', { target: 'dev' }]]);
  dayVote(s, { bob: 'ana', eve: 'ana', fay: 'ana', gus: 'ana' });
  assert.deepEqual(seen(s, 'eve', 'ana').revealed, { kind: 'wolf', value: true });
  assert.deepEqual(seen(s, 'eve', 'dev').revealed, { kind: 'wolf', value: false });
  nextNight(s);
  playNight(s, [['bob', { target: 'hal' }]]);
  dayVote(s, { bob: 'cal', eve: 'cal', fay: 'cal' });
  assert.deepEqual(seen(s, 'eve', 'cal').revealed, { kind: 'wolf', value: false });
  assert.equal(seen(s, 'eve', 'cal').role, null);
});

// ---------------------------------------------------------------- First night and pacing

test('First night: with firstNightKill off, the pack gets no kill on night 1 and only meets', () => {
  const s = startGame(PACK, { firstNightKill: false });
  const t = task(s, 'ana');
  assert.equal(t.kind, 'meet');
  assert.deepEqual(t.targets, []);
  assert.equal(t.wolf, undefined);
  assert.equal(s.deadlines.packLock, undefined);
  playNight(s);
  assert.equal(G.aliveIds(s).length, 8);
  dayVote(s, {});
  nextNight(s);
  assert.equal(task(s, 'ana').kind, 'wolf');
});

test('Pacing: a night never resolves before nightMinSeconds, even when everyone acted early', () => {
  const s = startGame(BASIC);
  act(s, 'ana', { target: 'dev' }, 1000);
  fillNight(s, 1000);
  act(s, 'cal', { target: 'cal' }, 1000);
  assert.equal(s.phase, 'night');
  G.onDeadline(s, 19999);
  assert.equal(s.phase, 'night');
  G.onDeadline(s, 20000);
  assert.equal(s.phase, 'day');
  const late = startGame(BASIC);
  act(late, 'ana', { target: 'dev' }, 1000);
  fillNight(late, 1000);
  G.onDeadline(late, 20000);
  assert.equal(late.phase, 'night');
  act(late, 'cal', { target: 'cal' }, 25000);
  assert.equal(late.phase, 'day', 'the last task after the minimum ends the night at once');
});

test('Pacing: a paused timer resumes with the same time left', () => {
  const s = startGame(BASIC);
  host(s, 'pause', 30000, { isHost: true });
  assert.equal(G.nextDeadline(s), null);
  const v = view(s, 'ben');
  assert.equal(v.paused, true);
  assert.deepEqual(v.deadline, { endsAt: null, remainingMs: 60000, label: 'Night ends' });
  G.onDeadline(s, 1e9);
  assert.equal(s.phase, 'night');
  assert.deepEqual(view(s, 'ben', { isHost: true }).hostActions, ['resume', 'extend']);
  host(s, 'resume', 500000, { isHost: true });
  assert.equal(view(s, 'ben').deadline.endsAt, 560000);
  assert.equal(s.deadlines.packLock, 540000);
  host(s, 'extend', 500000, { isHost: true });
  assert.equal(view(s, 'ben').deadline.endsAt, 590000);
  assert.equal(s.deadlines.packLock, 570000, 'the pack lock follows the night deadline');
});

// ---------------------------------------------------------------- Host limits

test('Host limits: nobody can end a night early', () => {
  const s = startGame(BASIC);
  const ctx = { isHost: true, isOnline: () => true };
  assert.deepEqual(view(s, 'ana', ctx).hostActions, ['pause', 'extend']);
  for (const a of ['start-night', 'start-vote', 'end-vote', 'skip-shot', 'next-night']) {
    throwsCode(() => host(s, a, 1000, ctx), 'NOT_ALLOWED');
  }
  throwsCode(() => host(s, 'end-night', 1000, ctx), 'BAD_REQUEST');
  assert.deepEqual(view(s, 'ben').hostActions, [], 'only the host gets host actions');
  assert.equal(s.phase, 'night');
});

test('Host limits: host actions follow the day stage', () => {
  const s = startGame(HUNTER);
  const ctx = { isHost: true, isOnline: () => true };
  playNight(s, [['ana', { target: 'cal' }]]);
  assert.deepEqual(view(s, 'ben', ctx).hostActions, ['start-vote', 'pause', 'extend']);
  host(s, 'start-vote', T(s), ctx);
  assert.deepEqual(view(s, 'ben', ctx).hostActions, ['end-vote', 'pause', 'extend']);
  host(s, 'end-vote', T(s), ctx);
  assert.deepEqual(view(s, 'ben', ctx).hostActions, ['next-night', 'pause', 'extend']);
  host(s, 'next-night', T(s), ctx);
  assert.equal(s.phase, 'night');
  assert.equal(s.round, 2);
});

test('Host limits: a dead host doesn\'t get the dead players\' full view', () => {
  const s = startGame({ ...BASIC, fay: 'villager' }, { deadSeeRoles: true, reveal: 'none' });
  playNight(s, [['ana', { target: 'dev' }]]);
  const asHost = view(s, 'dev', { isHost: true });
  assert.deepEqual(asHost.players.map((p) => p.role), [null, null, null, 'villager', null, null]);
  const asPlayer = view(s, 'dev', {});
  assert.deepEqual(asPlayer.players.map((p) => p.role), ['werewolf', 'seer', 'doctor', 'villager', 'villager', 'villager']);
  assert.deepEqual(view(s, 'eve').players.map((p) => p.role), [null, null, null, null, 'villager', null]);
  const off = startGame({ ...BASIC, fay: 'villager' }, { reveal: 'none' });
  playNight(off, [['ana', { target: 'dev' }]]);
  assert.deepEqual(view(off, 'dev').players.map((p) => p.role), [null, null, null, 'villager', null, null]);
});

test('deadSeeRoles: a dead Hunter sees every role only once the shot is resolved', () => {
  const s = startGame(HUNTER, { deadSeeRoles: true, reveal: 'none' });
  playNight(s, [['ana', { target: 'ben' }]]);
  assert.equal(s.day.stage, 'shot');
  assert.equal(view(s, 'ben').players.find((p) => p.id === 'ana').role, null);
  G.shoot(s, 'ben', 'cal', T(s));
  assert.equal(view(s, 'ben').players.find((p) => p.id === 'ana').role, 'werewolf');
  assert.equal(view(s, 'cal').players.find((p) => p.id === 'ana').role, 'werewolf', 'the shot victim sees all too');
  assert.equal(view(s, 'dev').players.find((p) => p.id === 'ana').role, null);
});

// ---------------------------------------------------------------- What each role knows

test('Visibility: killer wolves see each other, the Minion sees the killers, Masons see each other', () => {
  const roles = {
    ana: 'werewolf', bob: 'wolfcub', cal: 'minion', dev: 'mason', eve: 'mason',
    fay: 'villager', gus: 'seer', hal: 'sorceress', ivy: 'villager', jon: 'villager',
  };
  const s = makeGame(roles);
  const visible = (id) => view(s, id).players.filter((p) => p.role).map((p) => p.id);
  assert.deepEqual(visible('ana'), ['ana', 'bob']);
  assert.deepEqual(view(s, 'ana').me.knows, { pack: ['bob'], masons: [], wolves: [], lover: null });
  assert.deepEqual(visible('cal'), ['ana', 'bob', 'cal']);
  assert.deepEqual(view(s, 'cal').me.knows.wolves, ['ana', 'bob']);
  assert.deepEqual(view(s, 'cal').me.knows.pack, []);
  assert.deepEqual(visible('dev'), ['dev', 'eve']);
  assert.deepEqual(view(s, 'eve').me.knows.masons, ['dev']);
  assert.deepEqual(visible('hal'), ['hal'], 'the Sorceress knows nobody');
  assert.deepEqual(visible('gus'), ['gus']);
  assert.deepEqual(visible('fay'), ['fay']);
  const outsider = view(s, 'zed');
  assert.equal(outsider.me, null);
  assert.deepEqual(outsider.players.filter((p) => p.role), []);
  assert.deepEqual(outsider.rolesInPlay, { werewolf: 1, wolfcub: 1, minion: 1, mason: 2, villager: 3, seer: 1, sorceress: 1 });
  assert.equal(view(s, 'ana').me.team, 'wolves');
});

test('Visibility: no count of finished night tasks; a decoy\'s view doesn\'t change as others act', () => {
  const s = startGame({ ...PACK, hal: 'seer', ivy: 'doctor' });
  const watchers = ['cal', 'dev', 'zed'];
  const before = watchers.map((id) => JSON.stringify(view(s, id, id === 'cal' ? { isHost: true } : {})));
  act(s, 'hal', { target: 'ana' }, 1000);
  act(s, 'ivy', { target: 'eve' }, 1000);
  act(s, 'eve', { target: 'ana' }, 1000);
  act(s, 'ana', { target: 'gus' }, 1000);
  act(s, 'bob', { target: 'gus' }, 1000);
  act(s, 'ben', { heal: null, poison: null }, 1000);
  const after = watchers.map((id) => JSON.stringify(view(s, id, id === 'cal' ? { isHost: true } : {})));
  assert.deepEqual(after, before);
  assert.deepEqual(Object.keys(view(s, 'cal').night), ['task']);
  assert.doesNotMatch(JSON.stringify(view(s, 'cal')), /"(done|finished|acted|ready)Count"/);
});

// ---------------------------------------------------------------- Ghosts

test('Ghosts: a dead player guesses, never holds up the night, and is scored only at game over', () => {
  const s = startGame({ ana: 'werewolf', ben: 'seer', cal: 'villager', dev: 'villager', eve: 'villager', fay: 'villager', gus: 'villager' });
  playNight(s, [['ana', { target: 'cal' }]]);
  dayVote(s, {});
  nextNight(s);
  const g = task(s, 'cal');
  assert.equal(g.kind, 'ghost');
  assert.deepEqual(g.targets, ['ana', 'ben', 'dev', 'eve', 'fay', 'gus']);
  act(s, 'cal', { target: 'dev' });
  assert.deepEqual(view(s, 'cal').ghost, { guess: 'dev' });
  playNight(s, [['ana', { target: 'dev' }]]);
  assert.equal(view(s, 'cal').history, null);
  assert.equal(view(s, 'cal').ghost.score, undefined);
  dayVote(s, {});
  nextNight(s);
  // The ghosts don't guess; the night still ends at the minimum.
  act(s, 'ana', { target: 'eve' }, 1000 + s.deadlines.nightMin - 20000);
  fillNight(s, s.deadlines.nightMin - 1);
  G.onDeadline(s, s.deadlines.nightMin);
  assert.equal(s.phase, 'day');
  dayVote(s, { ben: 'ana', fay: 'ana' });
  assert.equal(s.phase, 'over');
  assert.deepEqual(view(s, 'cal').ghost.score, { right: 1, total: 1 });
  assert.ok(view(s, 'ben').history.some((h) => /ghost guessed Dev/.test(h.text)));
});

test('Ghosts: guesses never change any outcome', () => {
  const play = (guess) => {
    const s = startGame({ ana: 'werewolf', ben: 'seer', cal: 'villager', dev: 'villager', eve: 'villager', fay: 'villager', gus: 'villager' });
    playNight(s, [['ana', { target: 'cal' }]]);
    dayVote(s, { ana: 'dev', ben: 'dev', eve: 'dev' });
    nextNight(s);
    if (guess) { act(s, 'cal', { target: 'eve' }); act(s, 'dev', { target: 'ana' }); }
    playNight(s, [['ana', { target: 'eve' }]]);
    return { alive: G.aliveIds(s), log: s.log, phase: s.phase, rng: s.rngState, day: s.day };
  };
  assert.deepEqual(play(true), play(false));
});

// ---------------------------------------------------------------- Random games: visibility oracle

const KILLERS = ['werewolf', 'shadowwolf', 'wolfcub'];

// PLAN.md "Who sees whose role", written out independently of the engine.
function mayKnowRole(s, viewerId, targetId, isHost) {
  const t = s.players[targetId];
  if (s.phase === 'over' || viewerId === targetId) return true;
  if (t.role === 'prince' && t.flags.princeUsed) return true;           // a revealed Prince
  if (t.role === 'hunter' && t.flags.shot) return true;                 // the Hunter once they shoot
  if (!t.alive && (s.settings.reveal === 'role' || (s.settings.reveal === 'day' && t.diedPhase === 'day'))) return true;
  const v = s.players[viewerId];
  if (!v) return false;
  if (!v.alive && s.settings.deadSeeRoles && !isHost && !s.pendingShots.includes(viewerId)) return true;
  if (KILLERS.includes(t.role) && (KILLERS.includes(v.role) || v.role === 'minion')) return true;
  return v.role === 'mason' && t.role === 'mason';
}

function checkViews(s, viewers, hostId) {
  for (const id of viewers) {
    const isHost = id === hostId;
    const v = G.viewFor(s, id, { isHost, isOnline: () => true });
    assert.equal(v.players.length, s.order.length);
    for (const p of v.players) {
      const truth = s.players[p.id];
      assert.equal(p.role, mayKnowRole(s, id, p.id, isHost) ? truth.role : null, `${id} sees ${p.id}`);
      assert.equal(p.alive, truth.alive);
      if (p.alive) assert.equal(p.revealed, null);
      if (s.phase !== 'over') assert.ok(!['wolves', 'poison'].includes(p.cause));
    }
    if (s.phase !== 'over') assert.equal(v.history, null);
    if (v.me) {
      assert.deepEqual(v.me.notes, s.notes[id] || []);
      assert.deepEqual(v.me.marks, s.marks[id] || {});
    }
    if (v.night) assert.deepEqual(Object.keys(v.night), ['task']);
    if (v.night && v.night.task) {
      const k = v.night.task.kind;
      if (k !== 'wolf') assert.equal(v.night.task.wolf, undefined);
      if (k !== 'witch') assert.equal(v.night.task.witch, undefined);
    }
    if (v.day) {
      for (const a of v.day.announcements) assert.ok(a.kind !== 'private' || s.day.announcements.some((x) => x.to === id && x.text === a.text));
      if (v.day.shot) assert.equal(s.day.shooter, id);
      if (v.day.vote && s.settings.voteStyle === 'secret') assert.equal(v.day.vote.live, null);
    }
    if (!isHost) assert.deepEqual(v.hostActions, []);
  }
}

// One random legal action, or null when only time can move the game on.
function randomMove(s, rng, hostId) {
  const pickOne = (list) => list[Math.floor(rng() * list.length)];
  const moves = [];
  const v = (id) => G.viewFor(s, id, { isHost: id === hostId, isOnline: () => rng() < 0.7 });
  if (s.phase === 'reveal') {
    for (const id of s.order) if (!s.reveal.seen.includes(id)) moves.push((t) => G.seenRole(s, id, t));
  } else if (s.phase === 'night') {
    for (const id of s.order) {
      const k = v(id).night.task;
      if (k.done) continue;
      if (k.kind === 'witch') {
        if (k.witch.waiting) continue;
        const heal = k.witch.canHeal && rng() < 0.5 ? pickOne(k.witch.victims) : null;
        const poison = k.witch.canPoison && rng() < 0.2 ? pickOne(k.targets) : null;
        moves.push((t) => G.nightAction(s, id, { heal, poison }, t));
      } else if (k.kind === 'cupid') {
        const a = pickOne(k.targets);
        const b = pickOne(k.targets.filter((x) => x !== a));
        moves.push((t) => G.nightAction(s, id, { targets: [a, b] }, t));
      } else if (k.kind === 'meet') {
        moves.push((t) => G.nightAction(s, id, {}, t));
      } else if (k.targets.length && (k.kind !== 'ghost' || rng() < 0.3)) {
        const target = pickOne(k.targets);
        moves.push((t) => G.nightAction(s, id, { target }, t));
      }
    }
  } else if (s.phase === 'day') {
    const d = s.day;
    if (d.stage === 'shot') {
      const sv = v(d.shooter);
      if (rng() < 0.8) moves.push((t) => G.shoot(s, d.shooter, pickOne(sv.day.shot.targets), t));
    } else if (d.stage === 'vote') {
      for (const id of G.aliveIds(s)) {
        const vv = v(id).day.vote;
        const options = ['skip', ...vv.eligible.filter((x) => x !== id && !vv.blocked.includes(x))];
        // Bias towards a few suspects so eliminations happen.
        const target = rng() < 0.6 ? options[1 + Math.floor(rng() * Math.min(3, options.length - 1))] || 'skip' : pickOne(options);
        moves.push((t) => G.vote(s, id, target, t));
      }
    }
    const acts = v(hostId).hostActions.filter((a) => !['pause', 'resume', 'extend', 'skip-shot'].includes(a));
    for (const a of acts) if (rng() < 0.3) moves.push((t) => G.hostAction(s, a, t, { isHost: true }));
  }
  return moves.length ? pickOne(moves) : null;
}

// A random request that may be illegal: it must either succeed or throw a GameError and change nothing.
function randomProbe(s, rng, now) {
  const ids = [...s.order, 'nobody'];
  const any = () => ids[Math.floor(rng() * ids.length)];
  const before = snap(s);
  const tries = [
    () => G.nightAction(s, any(), rng() < 0.5 ? { target: any() } : { heal: any(), poison: any() }, now),
    () => G.vote(s, any(), rng() < 0.2 ? 'skip' : any(), now),
    () => G.shoot(s, any(), any(), now),
    () => G.seenRole(s, any(), now),
  ];
  try {
    tries[Math.floor(rng() * tries.length)]();
    return true;
  } catch (e) {
    assert.ok(e instanceof G.GameError, `unexpected error: ${e && e.stack}`);
    assert.ok(['NOT_ALLOWED', 'BAD_TARGET', 'BAD_REQUEST'].includes(e.code), e.code);
    assert.equal(snap(s), before, 'a rejected request leaves state unchanged');
    return false;
  }
}

function randomGame(seed) {
  const rng = seeded(seed);
  const n = 5 + Math.floor(rng() * 16);
  const allowed = R.ROLE_IDS.filter(() => rng() < 0.6);
  const deck = R.buildAutoDeck({ playerCount: n, allowedRoles: allowed, rng });
  const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  const settings = {
    reveal: R.ROLE_IDS.length && ['role', 'day', 'team', 'wolf', 'none'][Math.floor(rng() * 5)],
    firstNightKill: rng() < 0.7,
    deadSeeRoles: rng() < 0.5,
    voteStyle: rng() < 0.5 ? 'secret' : 'live',
    discussionSeconds: [0, 30, 180][Math.floor(rng() * 3)],
    nightMinSeconds: [0, 20][Math.floor(rng() * 2)],
  };
  return { s: G.createGame({ players, roles: deck.roles, settings, now: 0, rng, timeScale: 1 }), rng };
}

test('Visibility: across random games, viewFor shows a role only where section 5 allows it', () => {
  const rolesSeen = new Set();
  const winners = {};
  for (let seed = 1; seed <= 120; seed++) {
    const { s, rng } = randomGame(seed);
    for (const r of Object.keys(s.rolesInPlay)) rolesSeen.add(r);
    const hostId = s.order[Math.floor(rng() * s.order.length)];
    const viewers = [...s.order, 'outsider'];
    let now = 0;
    for (let step = 0; step < 4000 && s.phase !== 'over'; step++) {
      checkViews(s, viewers, hostId);
      if (rng() < 0.15) randomProbe(s, rng, now);
      const next = G.nextDeadline(s);
      const move = rng() < 0.08 && next != null ? null : randomMove(s, rng, hostId);
      if (!move) {
        if (next == null) {
          // Only the host can move the game on (discussionSeconds 0); that must be offered.
          assert.ok(G.viewFor(s, hostId, { isHost: true }).hostActions.includes('start-vote'), `seed ${seed}: stalled`);
          continue;
        }
        now = Math.max(now, next);
        G.onDeadline(s, now);
        continue;
      }
      now = next == null ? now + 1 : Math.max(now, Math.min(next - 1, now + Math.floor(rng() * 3000)));
      const nightWatch = s.phase === 'night'
        ? s.order.filter((id) => !['wolf', 'witch'].includes(s.night.tasks[id].kind)) : [];
      const before = nightWatch.map((id) => JSON.stringify(G.viewFor(s, id, {})));
      const round = s.round;
      move(now);
      if (s.phase === 'night' && s.round === round) {
        // Nobody outside the pack and the Witch can tell that someone else acted.
        nightWatch.forEach((id, i) => {
          if (s.night.tasks[id].done) return;
          assert.equal(JSON.stringify(G.viewFor(s, id, {})), before[i], `seed ${seed}: ${id}'s night view changed`);
        });
      }
    }
    assert.equal(s.phase, 'over', `seed ${seed} did not finish`);
    assert.ok(s.round <= 40, `seed ${seed} took ${s.round} rounds`);
    checkViews(s, viewers, hostId);
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
    winners[s.winner.team] = (winners[s.winner.team] || 0) + 1;
  }
  assert.ok(rolesSeen.size >= 15, `only ${rolesSeen.size} roles were dealt`);
  assert.ok(winners.village && winners.wolves, JSON.stringify(winners));
});

test('State is plain JSON: a game replayed through JSON.parse(JSON.stringify()) at every step ends the same', () => {
  for (const seed of [3, 11, 29]) {
    const play = (roundTrip) => {
      let { s, rng } = randomGame(seed);
      const hostId = s.order[0];
      let now = 0;
      for (let step = 0; step < 4000 && s.phase !== 'over'; step++) {
        if (roundTrip) s = JSON.parse(JSON.stringify(s));
        const next = G.nextDeadline(s);
        const move = rng() < 0.08 && next != null ? null : randomMove(s, rng, hostId);
        if (!move) {
          if (next == null) continue;
          now = Math.max(now, next);
          G.onDeadline(s, now);
          continue;
        }
        now = next == null ? now + 1 : Math.max(now, Math.min(next - 1, now + 700));
        move(now);
      }
      return s;
    };
    const plain = play(false);
    assert.equal(plain.phase, 'over');
    assert.deepEqual(play(true), plain);
  }
});

// ---------------------------------------------------------------- Edge-case rulings (PLAN.md section 5)

test('Edge cases: a Seer killed in the night still receives that night\'s answer', () => {
  const s = startGame(BASIC);
  act(s, 'ben', { target: 'ana' });
  playNight(s, [['ana', { target: 'ben' }]]);
  assert.ok(dead(s, 'ben'));
  const v = view(s, 'ben');
  assert.equal(v.me.marks.ana, 'wolf');
  assert.match(v.me.notes[0].text, /Ana is a werewolf/);
});

test('Edge cases: the Doctor blocks neither heartbreak nor the Hunter\'s shot', () => {
  const s = startGame({ ...CUPID, eve: 'doctor', fay: 'hunter' });
  playNight(s, [['ben', { targets: ['cal', 'dev'] }], ['ana', { target: 'cal' }], ['eve', { target: 'dev' }]]);
  assert.ok(dead(s, 'cal') && dead(s, 'dev'), 'protected, but heartbroken');
  dayVote(s, { ana: 'fay', ben: 'fay', eve: 'fay' });
  assert.equal(s.day.stage, 'shot');
  throwsCode(() => G.shoot(s, 'fay', 'cal', T(s)), 'BAD_TARGET');   // the dead can't be shot
  G.shoot(s, 'fay', 'ben', T(s));
  assert.ok(dead(s, 'ben'));
});

test('Pacing: pausing a night freezes the night minimum too', () => {
  const s = startGame(BASIC);
  act(s, 'ana', { target: 'dev' }, 1000);
  fillNight(s, 1000);
  act(s, 'cal', { target: 'cal' }, 1000);
  host(s, 'pause', 10000, { isHost: true });
  G.onDeadline(s, 50000);
  assert.equal(s.phase, 'night');
  host(s, 'resume', 100000, { isHost: true });
  assert.equal(G.nextDeadline(s), 110000, '10 s of the minimum were left');
  G.onDeadline(s, 110000);
  assert.equal(s.phase, 'day');
});

test('Pacing: pausing the shot, the vote or the verdict keeps its time; a stage change clears the pause', () => {
  const s = startGame(HUNTER);
  playNight(s, [['ana', { target: 'ben' }]]);
  const shotAt = s.deadlines.shot;
  host(s, 'pause', shotAt - 10000, { isHost: true });
  assert.equal(view(s, 'cal').deadline.remainingMs, 10000);
  G.shoot(s, 'ben', 'cal', shotAt + 50000);
  assert.equal(s.day.stage, 'discussion');
  assert.equal(view(s, 'dev').paused, false);
});

// ---------------------------------------------------------------- Auto balance (src/roles.js)

test('Auto balance: every player count 5 to 20 gets a legal deck in range; random pools are legal or flagged', () => {
  for (const tilt of ['balanced', 'village', 'wolves']) {
    for (const reveal of ['role', 'day', 'team', 'wolf', 'none']) {
      for (let n = 5; n <= 20; n++) {
        const d = R.buildAutoDeck({ playerCount: n, tilt, reveal, rng: seeded(n * 7 + tilt.length) });
        assert.deepEqual(R.validateDeck(d.roles, n), [], `${tilt}/${reveal}/${n}`);
        assert.equal(d.inRange, true, `${tilt}/${reveal}/${n}: ${d.score} not in ${d.target}`);
        assert.ok(d.score >= d.target[0] && d.score <= d.target[1]);
      }
    }
  }
  const rng = seeded(2024);
  for (let i = 0; i < 400; i++) {
    const n = 5 + Math.floor(rng() * 16);
    const allowed = R.ROLE_IDS.filter(() => rng() < 0.4);
    const d = R.buildAutoDeck({ playerCount: n, allowedRoles: allowed, tilt: 'balanced', reveal: 'role', rng });
    assert.deepEqual(R.validateDeck(d.roles, n), []);
    const ok = new Set([...allowed, 'werewolf', 'villager']);
    for (const r of Object.keys(d.roles)) assert.ok(ok.has(r), `${r} was not allowed`);
    if (d.inRange) assert.ok(d.score >= d.target[0] && d.score <= d.target[1]);
    else {
      assert.ok(d.suggestions.length > 0, `out of range (${d.score}) with no suggestion`);
      for (const r of d.suggestions) assert.ok(!ok.has(r), 'suggests only roles not yet allowed');
    }
    const g = G.createGame({ players: Array.from({ length: n }, (_, k) => ({ id: `q${k}`, name: `Q${k}` })), roles: d.roles, now: 0, rng });
    assert.equal(g.phase, 'reveal', 'every auto deck can start a game');
  }
});
