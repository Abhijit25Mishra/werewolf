'use strict';
// Lobby and session tests over real sockets (PLAN.md "Testing plan", docs/PROTOCOL.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const { createServer } = require('../server');

const HAS_ENGINE = fs.existsSync(path.join(__dirname, '..', 'src', 'game.js'));
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A test phone: records every event and waits for states or events that match.
class Client {
  constructor(url, auth = null) {
    this.auth = auth;
    this.seat = null;
    this.state = null;
    this.events = [];
    this.waiters = [];
    this.socket = io(url, {
      auth: (cb) => cb(this.auth || {}),
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    this.socket.onAny((event, payload) => {
      this.events.push({ event, payload });
      if (event === 'state') this.state = payload;
      this.check();
    });
  }

  check() {
    this.waiters = this.waiters.filter((w) => {
      const hit = w.test();
      if (hit === undefined) return true;
      clearTimeout(w.timer);
      w.resolve(hit);
      return false;
    });
  }

  wait(testFn, label, ms = 3000) {
    const hit = testFn();
    if (hit !== undefined) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { test: testFn, resolve };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`timed out waiting for ${label}`));
      }, ms);
      this.waiters.push(w);
    });
  }

  // Resolves with the latest state once it matches.
  waitState(pred, label = 'a matching state', ms) {
    return this.wait(() => (this.state && pred(this.state) ? this.state : undefined), label, ms);
  }

  // Resolves with the first state ever received that matches, even if newer ones came since.
  waitAnyState(pred, label = 'a matching state', ms) {
    return this.wait(() => {
      const e = this.events.find((x) => x.event === 'state' && pred(x.payload));
      return e ? e.payload : undefined;
    }, label, ms);
  }

  // Resolves with the payload of the first `name` event received at or after index `from`.
  waitEvent(name, from = 0, ms) {
    return this.wait(() => {
      const e = this.events.slice(from).find((x) => x.event === name);
      return e ? e.payload : undefined;
    }, `event ${name}`, ms);
  }

  // Paced to stay under the server's 10 events a second, like a human tapping.
  async emit(event, payload = {}) {
    this.sent = (this.sent || []).filter((t) => Date.now() - t < 1050);
    if (this.sent.length >= 9) await sleep(1050 - (Date.now() - this.sent[0]));
    this.sent.push(Date.now());
    return this.emitRaw(event, payload);
  }

  emitRaw(event, payload = {}) {
    return new Promise((resolve, reject) => {
      this.socket.timeout(3000).emit(event, payload, (err, res) => (err ? reject(err) : resolve(res)));
    });
  }

  async create(name) {
    const res = await this.emit('room:create', { name });
    if (res.ok) this.seat = { code: res.code, playerId: res.playerId, token: res.token };
    return res;
  }

  async join(code, name) {
    const res = await this.emit('room:join', { code, name });
    if (res.ok) this.seat = { code: res.code, playerId: res.playerId, token: res.token };
    return res;
  }

  get id() {
    return this.seat && this.seat.playerId;
  }

  close() {
    this.socket.close();
  }
}

let srv;
let url;
const opened = [];

function phone(auth) {
  const c = new Client(url, auth);
  opened.push(c);
  return c;
}

// A host plus one phone per extra name, all seated in a fresh room.
async function makeRoom(names) {
  const [first, ...rest] = names;
  const host = phone();
  const created = await host.create(first);
  assert.equal(created.ok, true, created.error);
  const others = [];
  for (const name of rest) {
    const c = phone();
    const res = await c.join(created.code, name);
    assert.equal(res.ok, true, res.error);
    others.push(c);
  }
  const all = [host, ...others];
  for (const c of all) await c.waitState((s) => s.room.players.length === names.length, `${names.length} players`);
  return { code: created.code, host, others, all };
}

const playerIn = (state, id) => state.room.players.find((p) => p.id === id);

test.before(async () => {
  srv = createServer({ timeScale: 100, minPlayers: 3 });
  const port = await srv.listen(0);
  url = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  for (const c of opened) c.close();
  await srv.close();
});

test('GET /healthz answers ok', async () => {
  const res = await fetch(`${url}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('GET /api/roles lists the 17 roles in display order', async () => {
  const res = await fetch(`${url}/api/roles`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /max-age/);
  const body = await res.json();
  assert.equal(body.roles.length, 17);
  assert.equal(body.roles[0].id, 'villager');
  assert.equal(body.roles.find((r) => r.id === 'mason').minIfAny, 2);
  for (const r of body.roles) for (const k of ['id', 'name', 'team', 'value', 'max', 'killer', 'acts', 'summary', 'rules', 'icon']) assert.ok(k in r, `${r.id}.${k}`);
});

test('GET /qr/:code.svg draws the join link; bad codes get 400', async () => {
  const res = await fetch(`${url}/qr/abcd.svg`, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'wolves.example.com' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await res.text(), /<svg[\s\S]*<\/svg>/);
  assert.equal((await fetch(`${url}/qr/AB1.svg`)).status, 400);
  assert.equal((await fetch(`${url}/qr/ABCI.svg`)).status, 400);
});

test('static files are served with Cache-Control: no-cache', async (t) => {
  const index = path.join(__dirname, '..', 'public', 'index.html');
  if (!fs.existsSync(index)) return t.skip('public/index.html is not there yet');
  const res = await fetch(`${url}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
});

test('the default crypto rng gives numbers in [0, 1) and joins work with it', async () => {
  const { cryptoRandom } = require('../server');
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const x = cryptoRandom();
    assert.ok(x >= 0 && x < 1, `out of range: ${x}`);
    seen.add(x);
  }
  assert.ok(seen.size > 4990, 'draws repeat far too often');
  // A server with no rng option deals with cryptoRandom on every join.
  const plain = createServer({ minPlayers: 3 });
  const port = await plain.listen(0);
  const a = new Client(`http://127.0.0.1:${port}`);
  const b = new Client(`http://127.0.0.1:${port}`);
  const c = new Client(`http://127.0.0.1:${port}`);
  try {
    const created = await a.create('Ana');
    assert.equal(created.ok, true, created.error);
    for (const [cl, name] of [[b, 'Ben'], [c, 'Cal']]) {
      const res = await cl.join(created.code, name);
      assert.equal(res.ok, true, res.error);
    }
    const s = await a.waitState((x) => x.room.players.length === 3, '3 players');
    const total = Object.values(s.room.deck.roles).reduce((n, k) => n + k, 0);
    assert.equal(total, 3);
    assert.deepEqual(s.room.deck.errors, []);
  } finally {
    for (const cl of [a, b, c]) cl.close();
    await plain.close();
  }
});

test('room:create seats the host and room:join adds players in join order', async () => {
  const host = phone();
  const created = await host.create('  Ana  ');
  assert.equal(created.ok, true);
  assert.match(created.code, CODE_RE);
  assert.match(created.playerId, /^[A-Za-z0-9_-]{12}$/);
  assert.match(created.token, /^[0-9a-f]{32}$/);
  const s = await host.waitState((x) => x.room.code === created.code, 'the host state');
  assert.equal(s.room.you, created.playerId);
  assert.equal(s.room.hostId, created.playerId);
  assert.equal(s.room.isHost, true);
  assert.equal(s.game, null);
  assert.equal(typeof s.serverNow, 'number');
  assert.deepEqual(s.room.players.map((p) => p.name), ['Ana']);
  assert.deepEqual(s.room.reclaims, []);
  assert.equal(s.room.settings.roleMode, 'auto');
  assert.equal(s.room.start.ok, false);
  assert.equal(s.room.start.reason, 'Need at least 3 players');

  const ben = phone();
  const joined = await ben.join(created.code.toLowerCase(), 'Ben');
  assert.equal(joined.ok, true);
  assert.equal(joined.code, created.code);
  const bs = await ben.waitState((x) => x.room.players.length === 2, 'Ben sees 2 players');
  assert.equal(bs.room.isHost, false);
  assert.equal(bs.room.you, joined.playerId);
  assert.deepEqual(bs.room.players.map((p) => [p.name, p.isHost, p.connected, p.ready, p.left, p.inGame]),
    [['Ana', true, true, false, false, false], ['Ben', false, true, false, false, false]]);
  await host.waitState((x) => x.room.players.length === 2, 'the host sees Ben');
});

test('names: trimmed, 1 to 16 characters, unique ignoring case; bad codes and rooms', async () => {
  const { code } = await makeRoom(['Dana']);
  const c = phone();
  assert.equal((await c.emit('room:join', { code, name: '   ' })).code, 'BAD_NAME');
  assert.equal((await c.emit('room:join', { code, name: 'x'.repeat(17) })).code, 'BAD_NAME');
  assert.equal((await c.emit('room:join', { code, name: 42 })).code, 'BAD_NAME');
  assert.equal((await c.emit('room:create', { name: '' })).code, 'BAD_NAME');
  assert.equal((await c.emit('room:join', { code, name: ' dANA ' })).code, 'NAME_TAKEN');
  assert.equal((await c.emit('room:join', { code: 'AB1', name: 'Eli' })).code, 'BAD_CODE');
  assert.equal((await c.emit('room:join', { code: 'ABCO', name: 'Eli' })).code, 'BAD_CODE');
  let missing = 'ZZZZ';
  while (srv.rooms.has(missing)) missing = missing === 'ZZZZ' ? 'YYYY' : 'XXXX';
  assert.equal((await c.emit('room:join', { code: missing, name: 'Eli' })).code, 'NO_ROOM');
  assert.equal((await c.emit('room:join', 'nonsense')).code, 'BAD_REQUEST');
  const long = await c.join(code, `  ${'y'.repeat(16)}  `);
  assert.equal(long.ok, true, long.error);
  const s = await c.waitState((x) => x.room.players.length === 2, 'two players');
  assert.equal(s.room.players[1].name, 'y'.repeat(16));
});

test('a room holds at most 20 players', async () => {
  const names = Array.from({ length: 20 }, (_, i) => `P${i + 1}`);
  const { code } = await makeRoom(names);
  const late = phone();
  const res = await late.emit('room:join', { code, name: 'P21' });
  assert.equal(res.code, 'ROOM_FULL');
});

test('events without a seat answer NOT_IN_ROOM', async () => {
  const c = phone();
  assert.equal((await c.emit('lobby:ready', { ready: true })).code, 'NOT_IN_ROOM');
  assert.equal((await c.emit('room:leave')).code, 'NOT_IN_ROOM');
  assert.equal((await c.emit('game:vote', { target: 'skip' })).code, 'NOT_IN_ROOM');
});

test('an offline name answers NAME_TAKEN_OFFLINE; the host approves a reclaim and the old token dies', async () => {
  const { code, host, others: [ben, cal] } = await makeRoom(['Ana', 'Ben', 'Cal']);
  const old = { ...ben.seat };
  ben.close();
  await host.waitState((s) => playerIn(s, old.playerId).connected === false, 'Ben offline');

  const phone2 = phone();
  const taken = await phone2.emit('room:join', { code, name: 'ben' });
  assert.equal(taken.code, 'NAME_TAKEN_OFFLINE');
  assert.equal((await phone2.emit('room:reclaim', { code, name: 'Cal' })).code, 'NAME_TAKEN'); // Cal is online
  assert.equal((await phone2.emit('room:reclaim', { code, name: 'Nobody' })).code, 'BAD_SEAT');

  const asked = await phone2.emit('room:reclaim', { code, name: 'BEN' });
  assert.equal(asked.ok, true, asked.error);
  assert.equal(typeof asked.requestId, 'string');
  const hs = await host.waitState((s) => s.room.reclaims.length === 1, 'the host sees the request');
  assert.deepEqual(hs.room.reclaims, [{ requestId: asked.requestId, name: 'Ben' }]);
  await cal.waitState((s) => s.room.players.length === 3, 'Cal state');
  assert.deepEqual(cal.state.room.reclaims, [], 'only the host sees takeover requests');
  assert.equal((await cal.emit('host:approve-reclaim', { requestId: asked.requestId, allow: true })).code, 'NOT_HOST');

  const approved = await host.emit('host:approve-reclaim', { requestId: asked.requestId, allow: true });
  assert.equal(approved.ok, true, approved.error);
  const result = await phone2.waitEvent('reclaim:result');
  assert.equal(result.ok, true);
  assert.equal(result.code, code);
  assert.equal(result.playerId, old.playerId);
  assert.match(result.token, /^[0-9a-f]{32}$/);
  assert.notEqual(result.token, old.token);
  const ps = await phone2.waitState((s) => s.room.you === old.playerId, 'the new phone holds the seat');
  assert.equal(playerIn(ps, old.playerId).connected, true);
  await host.waitState((s) => s.room.reclaims.length === 0 && playerIn(s, old.playerId).connected, 'request cleared');
  assert.equal((await host.emit('host:approve-reclaim', { requestId: asked.requestId, allow: true })).code, 'NOT_ALLOWED');

  // The old token is retired: resume fails and the handshake gets seat:invalid.
  const stale = phone();
  assert.equal((await stale.emit('room:resume', old)).code, 'BAD_SEAT');
  const staleAuth = phone(old);
  await staleAuth.waitEvent('seat:invalid');
  // The new token works from yet another device.
  const fresh = phone({ code, playerId: old.playerId, token: result.token });
  await fresh.waitState((s) => s.room.you === old.playerId, 'resume with the new token');
});

test('the host can refuse a reclaim, and a request dies when its seat comes back online', async () => {
  const { code, host, others: [ben] } = await makeRoom(['Ana', 'Ben', 'Cal']);
  const seat = { ...ben.seat };
  ben.close();
  await host.waitState((s) => !playerIn(s, seat.playerId).connected, 'Ben offline');
  const asker = phone();
  const first = await asker.emit('room:reclaim', { code, name: 'Ben' });
  assert.equal(first.ok, true);
  await host.waitState((s) => s.room.reclaims.length === 1, 'request listed');
  assert.equal((await host.emit('host:approve-reclaim', { requestId: first.requestId, allow: false })).ok, true);
  const no = await asker.waitEvent('reclaim:result');
  assert.equal(no.ok, false);
  assert.equal(typeof no.reason, 'string');
  await host.waitState((s) => s.room.reclaims.length === 0, 'request cleared');

  const from = asker.events.length;
  const second = await asker.emit('room:reclaim', { code, name: 'Ben' });
  assert.equal(second.ok, true);
  await host.waitState((s) => s.room.reclaims.length === 1, 'second request listed');
  phone(seat); // the old phone comes back
  const gone = await asker.waitEvent('reclaim:result', from);
  assert.equal(gone.ok, false);
  await host.waitState((s) => s.room.reclaims.length === 0 && playerIn(s, seat.playerId).connected, 'request dropped');
});

test('a saved seat in the handshake resumes at once; a stale one gets seat:invalid', async () => {
  const { code, host, others: [ben] } = await makeRoom(['Ana', 'Ben', 'Cal']);
  const seat = { ...ben.seat };
  ben.close();
  await host.waitState((s) => !playerIn(s, seat.playerId).connected, 'Ben offline');
  const back = phone(seat);
  const s = await back.waitState((x) => x.room.you === seat.playerId, 'resumed state');
  assert.equal(s.room.code, code);
  assert.equal(playerIn(s, seat.playerId).connected, true);
  await host.waitState((x) => playerIn(x, seat.playerId).connected, 'Ben back online');
  // A second tab on the same seat also gets a state.
  const tab = phone(seat);
  await tab.waitState((x) => x.room.you === seat.playerId, 'second tab state');

  await phone({ code, playerId: seat.playerId, token: '0'.repeat(32) }).waitEvent('seat:invalid');
  await phone({ code: 'QQQQ', playerId: 'nobody', token: 'x' }).waitEvent('seat:invalid');
  await phone({ code }).waitEvent('seat:invalid');
  const blank = phone();
  await sleep(50);
  assert.deepEqual(blank.events, [], 'no seat, no events');

  // room:resume from an unbound socket works too.
  assert.equal((await blank.emit('room:resume', seat)).ok, true);
  await blank.waitState((x) => x.room.you === seat.playerId, 'resume ack then state');
  assert.equal((await blank.emit('room:resume', { ...seat, token: 'nope' })).code, 'BAD_SEAT');
  assert.equal((await blank.emit('room:resume', { ...seat, code: 'A1' })).code, 'BAD_CODE');
});

test('the host kicks a player in the lobby; the kicked phone gets kicked and loses its seat', async () => {
  const { host, others: [ben, cal] } = await makeRoom(['Ana', 'Ben', 'Cal']);
  assert.equal((await cal.emit('lobby:kick', { playerId: ben.id })).code, 'NOT_HOST');
  assert.equal((await host.emit('lobby:kick', { playerId: host.id })).code, 'BAD_TARGET');
  assert.equal((await host.emit('lobby:kick', { playerId: 'nobody' })).code, 'BAD_TARGET');
  const res = await host.emit('lobby:kick', { playerId: ben.id });
  assert.equal(res.ok, true, res.error);
  const kicked = await ben.waitEvent('kicked');
  assert.equal(typeof kicked.reason, 'string');
  await host.waitState((s) => s.room.players.length === 2 && !playerIn(s, ben.id), 'Ben removed');
  assert.equal((await ben.emit('lobby:ready', { ready: true })).code, 'NOT_IN_ROOM');
  await phone(ben.seat).waitEvent('seat:invalid');
});

test('leaving the lobby removes the player; a host who leaves hands host on at once', async () => {
  const { code, host, others: [ben, cal] } = await makeRoom(['Ana', 'Ben', 'Cal']);
  const tab = phone(cal.seat); // Cal's second tab
  await tab.waitState((s) => s.room.you === cal.id, 'second tab');
  assert.equal((await cal.emit('room:leave')).ok, true);
  await tab.waitEvent('seat:invalid');
  await host.waitState((s) => s.room.players.length === 2 && !playerIn(s, cal.id), 'Cal removed');
  assert.equal((await cal.emit('lobby:ready', { ready: true })).code, 'NOT_IN_ROOM');

  assert.equal((await host.emit('room:leave')).ok, true);
  const s = await ben.waitState((x) => x.room.players.length === 1, 'host gone');
  assert.equal(s.room.hostId, ben.id);
  assert.equal(s.room.isHost, true);

  assert.equal((await ben.emit('room:leave')).ok, true);
  assert.equal(srv.rooms.has(code), false, 'an empty lobby is deleted');
});

test('host passes to the longest-joined connected player after 60 s (scaled) offline', async () => {
  const { host, others: [ben, cal] } = await makeRoom(['Ana', 'Ben', 'Cal']);
  const hostId = host.id;
  const t0 = Date.now();
  host.close();
  await ben.waitState((s) => !playerIn(s, hostId).connected, 'host offline');
  assert.equal(ben.state.room.hostId, hostId, 'host does not pass at once');
  const s = await ben.waitState((x) => x.room.hostId === ben.id, 'Ben becomes host');
  assert.ok(Date.now() - t0 >= 450, `host passed after ${Date.now() - t0} ms`);
  assert.equal(s.room.isHost, true);
  await cal.waitState((x) => x.room.hostId === ben.id && !x.room.isHost, 'Cal sees the new host');

  // The new host can hand host on, but only to a connected player.
  assert.equal((await cal.emit('host:transfer', { playerId: cal.id })).code, 'NOT_HOST');
  assert.equal((await ben.emit('host:transfer', { playerId: hostId })).code, 'BAD_TARGET');
  assert.equal((await ben.emit('host:transfer', { playerId: cal.id })).ok, true);
  await cal.waitState((x) => x.room.isHost && x.room.hostId === cal.id, 'Cal is host');
});

test('a host who comes back within the grace keeps host', async () => {
  const { host, others: [ben] } = await makeRoom(['Ana', 'Ben', 'Cal']);
  const seat = { ...host.seat };
  host.close();
  await ben.waitState((s) => !playerIn(s, seat.playerId).connected, 'host offline');
  await sleep(100);
  const back = phone(seat);
  await back.waitState((s) => s.room.isHost, 'host back');
  await sleep(700);
  assert.equal(ben.state.room.hostId, seat.playerId);
});

test('settings: host only, validated against the PROTOCOL ranges, and a change clears ready flags', async () => {
  const { host, others: [ben], all } = await makeRoom(['Ana', 'Ben', 'Cal']);
  const set = (c, patch) => c.emit('lobby:settings', { patch });
  assert.equal((await set(ben, { voteSeconds: 30 })).code, 'NOT_HOST');
  const bad = [
    { voteSeconds: 14 }, { voteSeconds: 181 }, { voteSeconds: 30.5 }, { discussionSeconds: 29 }, { discussionSeconds: 601 },
    { nightSeconds: 29 }, { nightSeconds: 301 }, { nightMinSeconds: 61 }, { nightMinSeconds: -1 },
    { nightSeconds: 30, nightMinSeconds: 40 }, { reveal: 'all' }, { roleMode: 'random' }, { balanceTilt: 'chaos' },
    { voteStyle: 'open' }, { firstNightKill: 'yes' }, { deadSeeRoles: 1 }, { allowedRoles: ['seer', 'dragon'] },
    { allowedRoles: 'seer' }, { roles: { seer: 2 } }, { roles: { dragon: 1 } }, { roles: { villager: -1 } }, { colour: 'red' },
  ];
  for (const patch of bad) assert.equal((await set(host, patch)).code, 'BAD_SETTINGS', JSON.stringify(patch));
  assert.equal((await host.emit('lobby:settings', { patch: 'fast' })).code, 'BAD_REQUEST');

  for (const c of all) assert.equal((await c.emit('lobby:ready', { ready: true })).ok, true);
  await host.waitState((s) => s.room.players.every((p) => p.ready), 'everyone ready');
  const ok = await set(host, { discussionSeconds: 0, voteSeconds: 15, nightSeconds: 30, nightMinSeconds: 30, allowedRoles: ['seer'], voteStyle: 'live' });
  assert.equal(ok.ok, true, ok.error);
  const s = await ben.waitState((x) => x.room.settings.voteStyle === 'live', 'new settings');
  assert.equal(s.room.settings.discussionSeconds, 0);
  assert.equal(s.room.settings.nightMinSeconds, 30);
  assert.deepEqual(s.room.settings.allowedRoles, ['villager', 'seer', 'werewolf'], 'werewolf and villager are always allowed');
  assert.ok(s.room.players.every((p) => !p.ready), 'a settings change clears every ready flag');
  assert.equal(s.room.countdownEndsAt, null);
  for (const id of Object.keys(s.room.deck.roles)) assert.ok(['villager', 'seer', 'werewolf'].includes(id), `auto deal used ${id}`);
});

test('auto and manual decks: band, target, errors, start reason and shuffle', async () => {
  const { host } = await makeRoom(['Ana', 'Ben', 'Cal']);
  let s = await host.waitState((x) => x.room.players.length === 3, 'three players');
  assert.equal(s.room.settings.roleMode, 'auto');
  assert.deepEqual(s.room.deck.errors, []);
  assert.deepEqual(s.room.deck.target, [-1, 3]);
  assert.equal(typeof s.room.deck.inRange, 'boolean');
  assert.ok(Array.isArray(s.room.deck.suggestions));
  assert.equal(s.room.start.reason, 'Waiting for 3 players to get ready');
  assert.equal((await host.emit('lobby:shuffle')).ok, true);

  assert.equal((await host.emit('lobby:settings', { patch: { roleMode: 'manual', roles: { werewolf: 1, villager: 1 }, reveal: 'none' } })).ok, true);
  s = await host.waitState((x) => x.room.settings.roleMode === 'manual', 'manual mode');
  assert.deepEqual(s.room.deck.roles, { villager: 1, werewolf: 1 });
  assert.equal(s.room.deck.score, -5);
  assert.equal(s.room.deck.band, 'wolves');
  assert.deepEqual(s.room.deck.target, [1, 5], 'no reveal shifts the target up by 2');
  assert.equal(s.room.deck.inRange, false);
  assert.ok(s.room.deck.errors.includes('Add 1 more role'));
  assert.equal(s.room.start.ok, false);
  assert.equal(s.room.start.reason, 'Roles add up to 2 but there are 3 players');
  assert.equal((await host.emit('lobby:shuffle')).code, 'NOT_ALLOWED');

  assert.equal((await host.emit('lobby:settings', { patch: { roles: { werewolf: 1, seer: 1, villager: 1 } } })).ok, true);
  s = await host.waitState((x) => Object.keys(x.room.deck.roles).length === 3, 'valid manual deck');
  assert.deepEqual(s.room.deck.errors, []);
  assert.equal(s.room.deck.score, 2);
  assert.equal(s.room.start.reason, 'Waiting for 3 players to get ready');
});

test('lobby:ready validates its payload; RATE_LIMITED past 10 events a second', async () => {
  const { host } = await makeRoom(['Ana', 'Ben', 'Cal']);
  assert.equal((await host.emit('lobby:ready', { ready: 'yes' })).code, 'BAD_REQUEST');
  await sleep(1100);
  const results = await Promise.all(Array.from({ length: 15 }, (_, i) => host.emitRaw('lobby:ready', { ready: i % 2 === 0 })));
  const limited = results.filter((r) => r.code === 'RATE_LIMITED');
  assert.equal(results.filter((r) => r.ok).length, 10);
  assert.equal(limited.length, 5);
  assert.equal(typeof limited[0].error, 'string');
  await sleep(1100);
  assert.equal((await host.emit('lobby:ready', { ready: false })).ok, true, 'the window slides on');
});

test('the countdown starts when everyone is ready and any change cancels it', async () => {
  // A real-length (5 s) countdown, so every cancel lands long before it would start a game.
  const slow = createServer({ timeScale: 1, minPlayers: 3 });
  const port = await slow.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const [a, b, c] = [new Client(base), new Client(base), new Client(base)];
  const extra = [];
  try {
    const { code } = await a.create('Ana');
    await b.join(code, 'Ben');
    await c.join(code, 'Cal');
    const readyAll = async () => {
      for (const x of [a, b, c]) assert.equal((await x.emit('lobby:ready', { ready: true })).ok, true);
      return a.waitState((s) => s.room.countdownEndsAt != null, 'countdown');
    };
    let s = await readyAll();
    assert.ok(s.room.countdownEndsAt - s.serverNow > 4000 && s.room.countdownEndsAt - s.serverNow <= 5000);
    assert.deepEqual(s.room.start, { ok: true, reason: null });

    assert.equal((await b.emit('lobby:ready', { ready: false })).ok, true);
    s = await a.waitState((x) => x.room.countdownEndsAt == null, 'cancelled by un-ready');
    assert.equal(s.room.start.reason, 'Waiting for 1 player to get ready');

    await readyAll();
    assert.equal((await a.emit('lobby:settings', { patch: { voteSeconds: 45 } })).ok, true);
    s = await c.waitState((x) => x.room.countdownEndsAt == null && x.room.settings.voteSeconds === 45, 'cancelled by settings');
    assert.ok(s.room.players.every((p) => !p.ready));

    await readyAll();
    const d = new Client(base);
    extra.push(d);
    assert.equal((await d.join(code, 'Dev')).ok, true);
    s = await a.waitState((x) => x.room.countdownEndsAt == null && x.room.players.length === 4, 'cancelled by a join');
    assert.ok(s.room.players.every((p) => !p.ready), 'the re-dealt deck clears ready flags');
    assert.equal(Object.values(s.room.deck.roles).reduce((n, k) => n + k, 0), 4);

    for (const x of [a, b, c, d]) assert.equal((await x.emit('lobby:ready', { ready: true })).ok, true);
    await a.waitState((x) => x.room.countdownEndsAt != null, 'countdown with 4');
    assert.equal((await d.emit('room:leave')).ok, true);
    s = await a.waitState((x) => x.room.countdownEndsAt == null && x.room.players.length === 3, 'cancelled by a leave');

    for (const x of [a, b, c]) assert.equal((await x.emit('lobby:ready', { ready: true })).ok, true);
    await a.waitState((x) => x.room.countdownEndsAt != null, 'countdown again');
    assert.equal((await a.emit('lobby:shuffle')).ok, true);
    await a.waitState((x) => x.room.countdownEndsAt == null, 'cancelled by a shuffle');
  } finally {
    for (const x of [a, b, c, ...extra]) x.close();
    await slow.close();
  }
});

const NO_ENGINE = !HAS_ENGINE && 'src/game.js is not there yet';

test('ready-up starts a game in the reveal phase; late joiners wait; leaving marks left; end-game goes back', { skip: NO_ENGINE }, async () => {
  const { code, host, others: [ben, cal], all } = await makeRoom(['Ana', 'Ben', 'Cal']);
  for (const c of all) assert.equal((await c.emit('lobby:ready', { ready: true })).ok, true);
  const counting = await host.waitAnyState((s) => s.room.countdownEndsAt != null, 'countdown');
  assert.ok(counting.room.countdownEndsAt - counting.serverNow <= 50);
  const s = await host.waitAnyState((x) => x.game && x.game.phase === 'reveal', 'reveal phase');
  assert.equal(s.room.countdownEndsAt, null);
  assert.deepEqual(s.room.start, { ok: false, reason: 'A game is in progress' });
  assert.ok(s.room.players.every((p) => p.inGame && !p.ready));
  assert.ok(s.game.hostActions.includes('pause'));
  assert.equal((await host.emit('host:advance', { action: 'pause' })).ok, true, 'the host pauses so the test can look around');
  await host.waitState((x) => x.game && x.game.paused, 'paused');
  const roles = [];
  for (const c of all) {
    const st = await c.waitState((x) => x.game && x.game.paused, 'paused everywhere');
    assert.equal(typeof st.game.me.role, 'string');
    roles.push(st.game.me.role);
    if (c !== host) assert.deepEqual(st.game.hostActions, []);
  }
  assert.ok(roles.includes('werewolf') || roles.includes('wolfcub') || roles.includes('shadowwolf'));

  // Someone arriving mid-game waits and sees the public view.
  const dev = phone();
  assert.equal((await dev.join(code, 'Dev')).ok, true);
  const ds = await dev.waitState((x) => x.game != null, 'Dev sees the game');
  assert.equal(ds.game.me, null);
  assert.equal(playerIn(ds, dev.id).inGame, false);
  assert.ok(ds.game.players.every((p) => p.id !== dev.id));
  assert.equal((await dev.emit('game:seen-role')).code, 'NOT_ALLOWED');
  assert.equal((await dev.emit('lobby:ready', { ready: true })).code, 'NOT_ALLOWED');
  assert.equal((await host.emit('lobby:settings', { patch: { voteSeconds: 20 } })).code, 'NOT_ALLOWED');
  assert.equal((await host.emit('lobby:kick', { playerId: dev.id })).code, 'NOT_ALLOWED');
  assert.equal((await host.emit('host:play-again')).code, 'NOT_ALLOWED');
  assert.equal((await ben.emit('host:advance', { action: 'resume' })).code, 'NOT_HOST');
  assert.equal((await host.emit('host:advance', { action: 'fly' })).ok, false);

  // Leaving mid-game keeps the seat in the game, marked left, and retires its token.
  const benSeat = { ...ben.seat };
  assert.equal((await ben.emit('room:leave')).ok, true);
  const hs = await host.waitState((x) => playerIn(x, benSeat.playerId).left, 'Ben marked left');
  assert.equal(playerIn(hs, benSeat.playerId).connected, false);
  assert.equal(playerIn(hs, benSeat.playerId).inGame, true);
  await phone(benSeat).waitEvent('seat:invalid');
  assert.equal((await phone().emit('room:join', { code, name: 'Ben' })).code, 'NAME_TAKEN');

  // The host aborts to the lobby: Ben is dropped, Dev joins the next game.
  assert.equal((await host.emit('host:end-game')).ok, true);
  const lobby = await cal.waitState((x) => x.game === null, 'back in the lobby');
  assert.deepEqual(lobby.room.players.map((p) => p.name), ['Ana', 'Cal', 'Dev']);
  assert.ok(lobby.room.players.every((p) => !p.ready && !p.left && !p.inGame));
  assert.equal(lobby.room.start.reason, 'Waiting for 3 players to get ready');
  assert.equal((await host.emit('host:end-game')).code, 'NOT_ALLOWED');
});

test('room timers drive the engine: the reveal phase ends by itself', { skip: NO_ENGINE }, async () => {
  const { all, host } = await makeRoom(['Ana', 'Ben', 'Cal']);
  for (const c of all) assert.equal((await c.emit('lobby:ready', { ready: true })).ok, true);
  await host.waitAnyState((x) => x.game && x.game.phase === 'reveal', 'reveal phase');
  const night = await host.waitAnyState((x) => x.game && x.game.phase === 'night', 'night after 60 s (scaled)', 4000);
  assert.equal(night.game.round, 1);
  assert.equal((await host.emit('host:end-game')).ok, true);
});

test('empty rooms are deleted after cleanupMs; rooms with someone connected stay', async () => {
  const quick = createServer({ timeScale: 100, minPlayers: 3, cleanupMs: 150, sweepMs: 30 });
  const port = await quick.listen(0);
  const a = new Client(`http://127.0.0.1:${port}`);
  const b = new Client(`http://127.0.0.1:${port}`);
  try {
    const gone = (await a.create('Ana')).code;
    const kept = (await b.create('Ben')).code;
    a.close();
    const until = Date.now() + 2000;
    while (quick.rooms.has(gone) && Date.now() < until) await sleep(20);
    assert.equal(quick.rooms.has(gone), false, 'the empty room was deleted');
    assert.equal(quick.rooms.has(kept), true, 'the room with a connected player stays');
  } finally {
    b.close();
    await quick.close();
  }
});

test('shutdown() sends server:shutdown to every socket, then closes', async () => {
  const doomed = createServer({ minPlayers: 3 });
  const port = await doomed.listen(0);
  const a = new Client(`http://127.0.0.1:${port}`);
  const b = new Client(`http://127.0.0.1:${port}`);
  try {
    await a.create('Ana');
    await b.emit('lobby:ready', { ready: true }); // unseated sockets are told too
    await doomed.shutdown('Restarting now');
    assert.deepEqual(await a.waitEvent('server:shutdown'), { message: 'Restarting now' });
    assert.deepEqual(await b.waitEvent('server:shutdown'), { message: 'Restarting now' });
  } finally {
    a.close();
    b.close();
    await doomed.close();
  }
});

test('close() stops every timer and the keep-alive, so the process exits', async () => {
  const script = `
    const { createServer } = require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});
    const { io } = require('socket.io-client');
    (async () => {
      const target = createServer({ minPlayers: 3 });
      const port = await target.listen(0);
      process.env.RENDER_EXTERNAL_URL = 'http://127.0.0.1:' + port + '/';
      const pinger = createServer({ keepAliveMs: 10, minPlayers: 3 });
      process.env.RENDER_EXTERNAL_URL = 'http://127.0.0.1:9';
      const failing = createServer({ keepAliveMs: 10, minPlayers: 3 });
      await pinger.listen(0);
      const c = io('http://127.0.0.1:' + port, { transports: ['websocket'], reconnection: false });
      const res = await new Promise((r) => c.emit('room:create', { name: 'Ana' }, r));
      await new Promise((r) => c.emit('lobby:ready', { ready: true }, r));
      await fetch('http://127.0.0.1:' + port + '/healthz').then((r) => r.text());
      await new Promise((r) => setTimeout(r, 400));
      await Promise.all([target.close(), pinger.close(), failing.close()]);
      console.log('closed ' + res.code);
    })().catch((e) => { console.error(e); process.exit(2); });
  `;
  const child = spawn(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: { ...process.env, RENDER_EXTERNAL_URL: '' } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('hung'); }, 8000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  assert.equal(code, 0, `child exit ${code}:\n${out}`);
  assert.match(out, /closed [A-Z]{4}/);
  assert.match(out, /\[keep-alive\] 10 pings sent/, 'every 10th ping is logged');
  assert.match(out, /\[keep-alive\] ping 1 to http:\/\/127\.0\.0\.1:9\/healthz failed/, 'failures are logged');
});

test('play-again after game over keeps the settings and drops players who left', { skip: NO_ENGINE }, async () => {
  const { host, all } = await makeRoom(['Ana', 'Ben', 'Cal', 'Dev']);
  const setup = { roleMode: 'manual', roles: { werewolf: 1, seer: 1, villager: 2 }, firstNightKill: false, discussionSeconds: 0, voteSeconds: 15, nightSeconds: 30, nightMinSeconds: 0 };
  assert.equal((await host.emit('lobby:settings', { patch: setup })).ok, true);
  await host.waitState((x) => x.room.settings.roleMode === 'manual' && x.room.deck.errors.length === 0, 'manual deck');
  for (const c of all) assert.equal((await c.emit('lobby:ready', { ready: true })).ok, true);
  for (const c of all) await c.waitAnyState((x) => x.game && x.game.phase === 'reveal', 'reveal');
  const roleOf = new Map(all.map((c) => [c, c.events.find((e) => e.event === 'state' && e.payload.game).payload.game.me.role]));
  const wolf = all.find((c) => roleOf.get(c) === 'werewolf');
  const leaver = all.find((c) => roleOf.get(c) === 'villager' && c !== host);
  assert.ok(wolf && leaver, `roles dealt: ${[...roleOf.values()]}`);

  await host.waitAnyState((x) => x.game && x.game.phase === 'day' && x.game.day.stage === 'discussion', 'day 1 discussion', 4000);
  const leaverId = leaver.id;
  assert.equal((await leaver.emit('room:leave')).ok, true);
  await host.waitState((x) => playerIn(x, leaverId).left, 'leaver marked left');
  assert.equal((await host.emit('host:advance', { action: 'start-vote' })).ok, true);
  for (const c of all.filter((x) => x !== leaver)) {
    const s = await c.waitState((x) => x.game.day && x.game.day.stage === 'vote' && x.game.day.vote, 'vote stage');
    if (!s.game.day.vote.canVote) continue;
    const target = c === wolf ? 'skip' : wolf.id;
    assert.equal((await c.emit('game:vote', { target })).ok, true);
  }
  const over = await host.waitAnyState((x) => x.game && x.game.phase === 'over', 'game over', 4000);
  assert.equal(over.game.winner.team, 'village');
  const guest = all.find((c) => c !== host && c !== leaver);
  assert.equal((await guest.emit('host:play-again')).code, 'NOT_HOST');

  assert.equal((await host.emit('host:play-again')).ok, true);
  const lobby = await host.waitState((x) => x.game === null, 'back in the lobby');
  assert.equal(lobby.room.players.length, 3);
  assert.ok(!playerIn(lobby, leaverId), 'the player who left is dropped');
  assert.ok(lobby.room.players.every((p) => !p.ready && !p.left));
  assert.equal(lobby.room.settings.roleMode, 'manual');
  assert.equal(lobby.room.settings.discussionSeconds, 0);
  assert.equal(lobby.room.start.reason, 'Roles add up to 4 but there are 3 players');
});
