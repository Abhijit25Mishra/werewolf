'use strict';
// Plays many seeded bot games over real sockets and checks every snapshot for leaks.
// SIM_GAMES and SIM_CONCURRENCY env vars shorten or widen the run.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');
const G = require('../src/game');
const { Bot, mulberry32 } = require('./helpers/bot');
const { checkSnapshot } = require('./helpers/oracle');

const GAMES = Number(process.env.SIM_GAMES || 200);
const CONCURRENCY = Number(process.env.SIM_CONCURRENCY || 8);
const GAME_TIMEOUT_MS = 60000;
const UNEXPECTED_ACK_CODES = new Set(['THROW', 'NO_ACK', 'BAD_REQUEST', 'BAD_SETTINGS', 'NOT_IN_ROOM']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The room's engine state, whatever the room store calls the field.
function engineState(room) {
  if (room.game && room.game.phase) return room.game;
  for (const v of Object.values(room)) if (v && typeof v === 'object' && typeof v.phase === 'string' && v.players) return v;
  return null;
}

async function playOne(url, srv, seed, sink) {
  const rng = mulberry32(seed);
  const n = 5 + Math.floor(rng() * 16); // 5..20 players
  const truthFor = (code) => {
    const room = srv.rooms.get(code);
    const st = room && engineState(room);
    return st ? { roles: G.trueRoles(st), alive: new Set(G.aliveIds(st)) } : null;
  };
  const onState = (bot, snap) => {
    for (const p of checkSnapshot(snap, truthFor)) sink.violations.push(`seed ${seed}, ${bot.name}: ${p}`);
  };
  const bots = [new Bot(url, 'Host', mulberry32(seed * 31 + 1), { onState })];
  try {
    const created = await bots[0].create();
    assert.ok(created.ok, `seed ${seed}: create failed: ${created.error}`);
    for (let i = 1; i < n; i++) {
      const b = new Bot(url, `Bot${i}`, mulberry32(seed * 31 + 1 + i), { onState });
      bots.push(b);
      const r = await b.join(created.code);
      assert.ok(r.ok, `seed ${seed}: join failed: ${r.error}`);
    }
    for (const b of bots) b.release();
    const started = Date.now();
    const host = bots[0];
    while (!(host.state && host.state.game && host.state.game.phase === 'over')) {
      if (Date.now() - started > GAME_TIMEOUT_MS) {
        const g = host.state && host.state.game;
        const where = g ? `${g.phase}${g.day ? '/' + g.day.stage : ''} round ${g.round}` : `lobby (${host.state && host.state.room.start.reason})`;
        throw new Error(`seed ${seed}: game with ${n} players stalled in ${where}`);
      }
      await sleep(15);
    }
    const g = host.state.game;
    for (const b of bots) for (const a of b.acks) if (UNEXPECTED_ACK_CODES.has(a.code)) sink.acks.push(`seed ${seed}, ${b.name}: ${a.event} -> ${a.code} ${a.error}`);
    return { seed, players: n, rounds: g.round, winner: g.winner && g.winner.team, roles: Object.keys(g.rolesInPlay || {}) };
  } finally {
    for (const b of bots) b.close();
  }
}

test(`${GAMES} seeded bot games finish without leaking secrets`, { timeout: 20 * 60 * 1000 }, async () => {
  const srv = createServer({ timeScale: 100, minPlayers: 5, cleanupMs: 300, sweepMs: 100 });
  const port = await srv.listen(0);
  const url = `http://127.0.0.1:${port}`;
  const sink = { violations: [], acks: [] };
  const results = [];
  try {
    let next = 0;
    const worker = async () => {
      while (next < GAMES) results.push(await playOne(url, srv, 1000 + next++, sink));
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const waitUntil = Date.now() + 3000;
    while (srv.rooms.size && Date.now() < waitUntil) await sleep(50);
    assert.equal(srv.rooms.size, 0, 'empty rooms are cleaned up');
  } finally {
    await srv.close();
  }
  assert.deepEqual(sink.violations.slice(0, 15), [], `${sink.violations.length} visibility problems`);
  assert.deepEqual(sink.acks.slice(0, 15), [], `${sink.acks.length} unexpected acks`);
  assert.equal(results.length, GAMES);
  const winners = {};
  for (const r of results) winners[r.winner] = (winners[r.winner] || 0) + 1;
  const coverage = new Set(results.flatMap((r) => r.roles));
  const maxRounds = Math.max(...results.map((r) => r.rounds));
  console.log(`# ${GAMES} games: winners ${JSON.stringify(winners)}, roles seen ${coverage.size}/17, longest ${maxRounds} rounds`);
  assert.ok(maxRounds <= 60, 'every game ends within 60 rounds (random bots drag games out far longer than people)');
  if (GAMES >= 100) assert.equal(coverage.size, 17, 'every role appears in some game');
});
