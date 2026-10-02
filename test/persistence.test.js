'use strict';
// Games survive a restart (docs/PROTOCOL.md "Surviving restarts"): two servers share one store;
// A hands its rooms over, B restores them when the phones reconnect.
const test = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { createServer } = require('../server');
const { createMemoryStore } = require('../src/store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A minimal test phone: keeps every event and waits for matching ones.
class Phone {
  constructor(url, auth = null) {
    this.events = [];
    this.waiters = [];
    this.state = null;
    this.seat = null;
    this.socket = io(url, { auth: (cb) => cb(auth || {}), transports: ['websocket'], forceNew: true, reconnection: false });
    this.socket.onAny((event, payload) => {
      this.events.push({ event, payload });
      if (event === 'state') this.state = payload;
      this.waiters = this.waiters.filter((w) => !w());
    });
  }

  wait(find, label, ms = 4000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
      const check = () => {
        const hit = find();
        if (hit === undefined) return false;
        clearTimeout(timer);
        resolve(hit);
        return true;
      };
      if (!check()) this.waiters.push(check);
    });
  }

  waitState(pred, label) {
    return this.wait(() => (this.state && pred(this.state) ? this.state : undefined), label);
  }

  waitEvent(name) {
    return this.wait(() => { const e = this.events.find((x) => x.event === name); return e ? e.payload : undefined; }, name);
  }

  emit(event, payload = {}) {
    return new Promise((resolve, reject) => {
      this.socket.timeout(4000).emit(event, payload, (err, res) => (err ? reject(err) : resolve(res)));
    });
  }

  close() {
    this.socket.close();
  }
}

test('a game survives a restart: same roles and phase, deadlines shifted by the downtime', async () => {
  const store = createMemoryStore(); // shared by both servers, like Render Key Value
  const A = createServer({ timeScale: 10, minPlayers: 3, store, instanceId: 'server-a' });
  const urlA = `http://127.0.0.1:${await A.listen(0)}`;
  const phones = [new Phone(urlA), new Phone(urlA), new Phone(urlA)];
  let B = null;
  let again = [];
  try {
    const [host, ...rest] = phones;
    const created = await host.emit('room:create', { name: 'Ana' });
    assert.equal(created.ok, true, created.error);
    host.seat = { code: created.code, playerId: created.playerId, token: created.token };
    for (const [p, name] of rest.map((p, i) => [p, ['Ben', 'Cal'][i]])) {
      const res = await p.emit('room:join', { code: created.code, name });
      assert.equal(res.ok, true, res.error);
      p.seat = { code: res.code, playerId: res.playerId, token: res.token };
    }
    const setup = { roleMode: 'manual', roles: { werewolf: 1, seer: 1, villager: 1 } };
    assert.equal((await host.emit('lobby:settings', { patch: setup })).ok, true);
    await host.waitState((s) => s.room.deck.errors.length === 0 && s.room.players.length === 3, 'a valid deck');
    for (const p of phones) assert.equal((await p.emit('lobby:ready', { ready: true })).ok, true);

    // Play into night 1: everyone reads their role, the Seer checks someone.
    for (const p of phones) await p.waitState((s) => s.game && s.game.phase === 'reveal', 'reveal');
    for (const p of phones) assert.equal((await p.emit('game:seen-role')).ok, true);
    for (const p of phones) await p.waitState((s) => s.game.phase === 'night', 'night 1');
    const seer = phones.find((p) => p.state.game.me.role === 'seer');
    const checked = await seer.emit('game:night-action', { target: seer.state.game.night.task.targets[0] });
    assert.equal(checked.ok, true, checked.error);
    await seer.waitState((s) => s.game.night.task.done, 'seer done');
    const before = phones.map((p) => ({ role: p.state.game.me.role, round: p.state.game.round, endsAt: p.state.game.deadline.endsAt }));
    const leftAtSave = before[0].endsAt - Date.now();

    // A shuts down gracefully: every phone is told to reconnect, the room stays in the store.
    await A.shutdown();
    for (const p of phones) {
      const notice = await p.waitEvent('server:restarting');
      assert.equal(typeof notice.message, 'string');
      assert.ok(notice.reconnectInMs > 0);
    }
    assert.ok(await store.get(`room:${created.code}`), 'the room snapshot is in the store');
    assert.equal(await store.get(`lease:${created.code}`), null, 'A released its lease');
    const raw = await store.get(`room:${created.code}`);
    assert.ok(!phones.some((p) => raw.includes(p.seat.token)), 'seat tokens are stored hashed');

    await sleep(700); // downtime
    B = createServer({ timeScale: 10, minPlayers: 3, store, instanceId: 'server-b' });
    const urlB = `http://127.0.0.1:${await B.listen(0)}`;
    again = phones.map((p) => new Phone(urlB, p.seat)); // the saved seats in the handshake
    for (const [i, p] of again.entries()) {
      const s = await p.waitState((x) => x.game, 'the restored game');
      assert.equal(s.room.code, created.code);
      assert.equal(s.room.you, phones[i].seat.playerId);
      assert.equal(s.game.phase, 'night');
      assert.equal(s.game.round, before[i].round);
      assert.equal(s.game.me.role, before[i].role);
      const shift = s.game.deadline.endsAt - before[i].endsAt;
      assert.ok(shift >= 650, `the night deadline moved by the downtime (${shift} ms)`);
      const left = s.game.deadline.endsAt - s.serverNow;
      assert.ok(Math.abs(left - leftAtSave) < 500, `the night kept its time left (${left} vs ${leftAtSave} ms)`);
    }
    const seerAgain = again[phones.indexOf(seer)];
    assert.equal(seerAgain.state.game.night.task.done, true);
    assert.deepEqual(seerAgain.state.game.night.task.result, checked.result);
    assert.equal(await store.get(`lease:${created.code}`), 'server-b', 'B holds the lease now');
    await again[0].waitState((s) => s.room.players.every((p) => p.connected), 'everyone back online');
  } finally {
    for (const p of [...phones, ...again]) p.close();
    await A.close();
    if (B) await B.close();
  }
});
