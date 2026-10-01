'use strict';
// A bot player for simulation tests. It sees only its own snapshots (docs/PROTOCOL.md)
// and picks random legal actions, the way a distracted human would.
const { io } = require('socket.io-client');
const R = require('../../src/roles');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Bot {
  constructor(url, name, rng, { onState, flaky = 0.05, hold = true } = {}) {
    this.name = name;
    this.rng = rng;
    this.flaky = flaky;
    this.hold = hold;        // stay unready in the lobby until release(), so every bot joins first
    this.seat = null;
    this.state = null;
    this.acks = [];          // failed acks: { event, code, error }
    this.configured = false; // host only: settings applied once
    this.timer = null;
    this.closed = false;
    this.onStateHook = onState || (() => {});
    this.socket = io(url, {
      auth: (cb) => cb(this.seat || {}),
      transports: ['websocket'],
      forceNew: true,
      reconnectionDelay: 20,
      reconnectionDelayMax: 60,
    });
    this.socket.on('state', (snap) => {
      this.state = snap;
      this.onStateHook(this, snap);
      this.schedule();
    });
    this.socket.on('seat:invalid', () => { this.seat = null; });
    this.socket.on('kicked', () => { this.kicked = true; });
    // Like a person glancing back at their phone: re-check now and then, even with no new
    // snapshot, so a declined roll or a RATE_LIMITED answer is retried instead of stalling.
    this.tick = setInterval(() => this.schedule(), 250);
  }

  emit(event, payload = {}) {
    return new Promise((resolve) => {
      this.socket.timeout(5000).emit(event, payload, (err, res) => {
        const out = err ? { ok: false, code: 'TIMEOUT', error: String(err) } : res || { ok: false, code: 'NO_ACK' };
        if (!out.ok) this.acks.push({ event, code: out.code, error: out.error });
        resolve(out);
      });
    });
  }

  async create() {
    const r = await this.emit('room:create', { name: this.name });
    if (r.ok) this.seat = { code: r.code, playerId: r.playerId, token: r.token };
    return r;
  }

  async join(code) {
    const r = await this.emit('room:join', { code, name: this.name });
    if (r.ok) this.seat = { code: r.code, playerId: r.playerId, token: r.token };
    return r;
  }

  pick(list) { return list.length ? list[Math.floor(this.rng() * list.length)] : null; }
  chance(p) { return this.rng() < p; }

  schedule() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.act().catch((e) => this.acks.push({ event: 'act', code: 'THROW', error: e.stack })); }, Math.floor(this.rng() * 40));
  }

  // Occasionally drop the connection and come back, like a phone locking its screen.
  maybeFlake() {
    if (!this.chance(this.flaky) || !this.socket.connected) return false;
    this.socket.disconnect();
    setTimeout(() => { if (!this.closed) this.socket.connect(); }, 20 + Math.floor(this.rng() * 60));
    return true;
  }

  async act() {
    const s = this.state;
    if (!s || this.closed || !this.seat) return;
    if (this.maybeFlake()) return;
    const room = s.room;
    const g = s.game;
    if (!g) return this.actLobby(room);
    const me = room.you;
    const host = room.isHost ? new Set(g.hostActions || []) : new Set();
    if (g.phase === 'reveal') {
      if (g.reveal && !g.reveal.youSeen) return this.emit('game:seen-role');
      if (host.has('start-night') && this.chance(0.2)) return this.emit('host:advance', { action: 'start-night' });
      return;
    }
    if (g.phase === 'night') return this.actNight(g, me);
    if (g.phase === 'day') return this.actDay(g, me, host);
    if (g.phase === 'over') this.over = g.winner;
  }

  release() {
    this.hold = false;
    this.schedule();
  }

  async actLobby(room) {
    if (this.hold) return;
    if (room.isHost && !this.configured) {
      this.configured = true;
      const allowed = R.ROLE_IDS.filter(() => this.chance(0.7));
      const patch = {
        roleMode: 'auto',
        allowedRoles: allowed,
        balanceTilt: this.pick(['balanced', 'balanced', 'village', 'wolves']),
        reveal: this.pick(['role', 'day', 'team', 'wolf', 'none']),
        firstNightKill: this.chance(0.8),
        deadSeeRoles: this.chance(0.5),
        voteStyle: this.pick(['secret', 'live']),
        discussionSeconds: this.pick([0, 30]),
        voteSeconds: 15,
        nightSeconds: 30,
        nightMinSeconds: this.pick([0, 5, 20]),
      };
      await this.emit('lobby:settings', { patch });
      return;
    }
    const mine = room.players.find((p) => p.id === room.you);
    if (mine && !mine.ready) return this.emit('lobby:ready', { ready: true });
  }

  async actNight(g, me) {
    const t = g.night && g.night.task;
    if (!t || t.done) return;
    const targets = t.targets || [];
    switch (t.kind) {
      case 'cupid': {
        const a = this.pick(targets);
        const b = this.pick(targets.filter((x) => x !== a));
        if (a && b) return this.emit('game:night-action', { targets: [a, b] });
        return;
      }
      case 'wolf': {
        // Follow the pack's most common pick so the wolves converge; otherwise pick at random.
        const picks = Object.values((t.wolf && t.wolf.picks) || {}).filter((x) => targets.includes(x));
        const counts = {};
        for (const x of picks) counts[x] = (counts[x] || 0) + 1;
        const top = Object.keys(counts).sort((x, y) => counts[y] - counts[x] || (x < y ? -1 : 1))[0];
        const mine = t.wolf && t.wolf.picks ? t.wolf.picks[me] : null;
        const choice = top || this.pick(targets);
        if (choice && choice !== mine) return this.emit('game:night-action', { target: choice });
        return;
      }
      case 'meet':
        return this.emit('game:night-action', {});
      case 'witch': {
        if (!t.witch || t.witch.waiting) return;
        const heal = t.witch.canHeal && t.witch.victims.length && this.chance(0.5) ? this.pick(t.witch.victims) : null;
        const poisonTargets = targets.filter((x) => x !== me);
        const poison = t.witch.canPoison && this.chance(0.25) ? this.pick(poisonTargets) : null;
        return this.emit('game:night-action', { heal, poison });
      }
      case 'ghost':
        if (this.chance(0.5)) return this.emit('game:night-action', { target: this.pick(targets) });
        return;
      default: // seer, doctor, sorceress, decoy
        if (targets.length) return this.emit('game:night-action', { target: this.pick(targets) });
    }
  }

  async actDay(g, me, host) {
    const d = g.day;
    if (!d) return;
    if (d.stage === 'shot') {
      if (d.shot && d.shot.targets.length && this.chance(0.9)) return this.emit('game:shoot', { target: this.pick(d.shot.targets) });
      if (host.has('skip-shot')) return this.emit('host:advance', { action: 'skip-shot' });
      return;
    }
    if (d.stage === 'discussion') {
      // An untimed discussion (discussionSeconds 0) only ends when the host starts the vote.
      if (host.has('start-vote') && (!g.deadline || this.chance(0.5))) return this.emit('host:advance', { action: 'start-vote' });
      return;
    }
    if (d.stage === 'vote') {
      const v = d.vote;
      if (v && v.canVote && v.myVote == null) {
        const options = v.eligible.filter((x) => x !== me && !v.blocked.includes(x));
        const target = this.chance(0.15) || !options.length ? 'skip' : this.pick(options);
        return this.emit('game:vote', { target });
      }
      if (host.has('end-vote') && this.chance(0.05)) return this.emit('host:advance', { action: 'end-vote' });
      return;
    }
    if (d.stage === 'verdict' && host.has('next-night') && this.chance(0.5)) {
      return this.emit('host:advance', { action: 'next-night' });
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.tick);
    clearTimeout(this.timer);
    this.socket.close();
  }
}

module.exports = { Bot, mulberry32 };
