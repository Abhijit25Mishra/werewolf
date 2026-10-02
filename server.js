'use strict';
// Express + Socket.IO on one HTTP server (PLAN.md section 7, docs/PROTOCOL.md).
// The room store lives in src/rooms.js and the rules engine in src/game.js; this file wires them
// to sockets, sends every player their own snapshot after each change, and runs the room timers.
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const roles = require('./src/roles');
const { G, RoomError, createRooms, normalizeCode, cleanName, CODE_RE, CODE_ALPHABET } = require('./src/rooms');
const { createMemoryStore, createDefaultStore } = require('./src/store');

const RATE_LIMIT = 10;          // events per socket per second
const RATE_WINDOW_MS = 1000;
const KEEP_ALIVE_MS = 150000;   // 2.5 minutes, as cultfit-agent does
const SWEEP_MS = 5 * 60 * 1000;
// Surviving restarts (docs/PROTOCOL.md): snapshot writes, per-room leases and deploy handover.
const PERSIST_DEFAULTS = {
  leaseMs: 15000,            // lease:<code> expiry
  leaseRenewMs: 5000,        // renewal interval for rooms this instance runs
  deployPollMs: 3000,        // how often to look for a newer instance in deploy:latest
  handoverDelayMs: 10000,    // wait after seeing a newer instance before handing rooms over
  saveDebounceMs: 1000,      // snapshot write after a change...
  saveMaxDelayMs: 5000,      // ...but never later than this after the first unsaved change
  roomTtlMs: 6 * 60 * 60 * 1000,
};
const SNAPSHOT_REFRESH_MS = 60 * 60 * 1000; // rewrite an idle room hourly so its TTL never lapses
const RETRY_MESSAGE = 'The server is restarting; try again in a moment';
const HANDOVER_NOTICE = { message: 'Updating the server…', reconnectInMs: 1500 };
const KNOWN_CODES = new Set(['NO_ROOM', 'ROOM_FULL', 'NAME_TAKEN', 'NAME_TAKEN_OFFLINE', 'BAD_NAME', 'BAD_CODE', 'BAD_SEAT',
  'NOT_IN_ROOM', 'NOT_HOST', 'NOT_ALLOWED', 'BAD_TARGET', 'BAD_SETTINGS', 'RATE_LIMITED', 'SERVER_FULL', 'BAD_REQUEST', 'RETRY']);

// Crypto-quality random numbers in [0, 1) for dealing and deck building, 48 bits each,
// read from a pooled buffer because the auto deck builder draws thousands per deal.
const randomPool = Buffer.alloc(6 * 1024);
let randomOffset = randomPool.length;
function cryptoRandom() {
  if (randomOffset + 6 > randomPool.length) {
    crypto.randomFillSync(randomPool);
    randomOffset = 0;
  }
  const n = randomPool.readUIntBE(randomOffset, 6);
  randomOffset += 6;
  return n / 2 ** 48;
}

function envMinPlayers() {
  const n = Number(process.env.MIN_PLAYERS);
  return Number.isInteger(n) && n > 0 ? n : roles.MIN_PLAYERS;
}

// The origin phones should open, as seen through Render's proxy.
function publicOrigin(req) {
  const forwarded = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
  const host = /^[A-Za-z0-9.:[\]-]+$/.test(forwarded) ? forwarded : req.get('host') || 'localhost';
  return `${req.protocol}://${host}`;
}

function createApp() {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  const roleList = JSON.stringify({ roles: roles.roleInfoList() });

  // Render's health check and the keep-alive: answers at once, depends on nothing.
  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store').type('text/plain').send('ok');
  });

  app.get('/api/roles', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600').type('application/json').send(roleList);
  });

  app.get('/qr/:code.svg', async (req, res) => {
    const code = String(req.params.code || '').toUpperCase();
    if (!CODE_RE.test(code)) return res.status(400).type('text/plain').send('Bad room code');
    try {
      const svg = await QRCode.toString(`${publicOrigin(req)}/?room=${code}`, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
      return res.set('Cache-Control', 'no-cache').type('image/svg+xml').send(svg);
    } catch (e) {
      console.error('[qr]', e);
      return res.status(500).type('text/plain').send('Could not draw the QR code');
    }
  });

  app.use(express.static(path.join(__dirname, 'public'), {
    cacheControl: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));
  return app;
}

function createServer(options = {}) {
  const timeScale = options.timeScale > 0 ? options.timeScale : 1;
  const lobby = createRooms({
    timeScale,
    minPlayers: options.minPlayers || envMinPlayers(),
    rng: options.rng || cryptoRandom,
    cleanupMs: options.cleanupMs,
    maxRooms: options.maxRooms,
  });
  const { rooms } = lobby;
  const sweepMs = options.sweepMs > 0 ? options.sweepMs : SWEEP_MS;
  const keepAliveMs = options.keepAliveMs > 0 ? options.keepAliveMs : KEEP_ALIVE_MS;
  const cfg = {};
  for (const [k, v] of Object.entries(PERSIST_DEFAULTS)) cfg[k] = options[k] > 0 ? options[k] : v;
  // options.store: a store object (tests share one memory store between servers), or false for
  // none. Without it a private memory store is used, which dies with this server, so it isn't
  // durable. Run directly, server.js passes Redis (REDIS_URL) or the file store.
  const store = options.store === false ? null : options.store || createMemoryStore({ durable: false });
  const ownsStore = options.store === undefined || !!options.ownStore;
  const durable = !!(store && store.durable);
  const instanceId = String(options.instanceId || process.env.RENDER_INSTANCE_ID || crypto.randomBytes(6).toString('hex'));

  const app = createApp();
  const httpServer = http.createServer(app);
  // Snapshots are repetitive JSON, so compressing frames over 1 KB cuts outbound traffic
  // several-fold; Render's free plan caps it at 5 GB a month.
  const io = new Server(httpServer, { maxHttpBufferSize: 64 * 1024, perMessageDeflate: { threshold: 1024 } });

  const timers = new Map();   // room code -> { at, handle }: one timeout per room
  const spins = new Map();    // room code -> deadlines that fired without moving on
  const lastSent = new Map(); // `${code}/${playerId}` -> last snapshot JSON (without serverNow)
  const dirty = new Set();    // room codes whose players need a fresh snapshot
  const forced = new Set();   // sockets that need a snapshot even if nothing changed
  const saves = new Map();    // room code -> { timer, firstAt }: the pending debounced write
  const chains = new Map();   // room code -> promise of that room's store writes, kept in order
  const savedPhase = new Map(); // room code -> phase key at the last write
  const savedAt = new Map();  // room code -> time of the last successful write
  const restoring = new Map(); // room code -> promise of a restore in progress
  let closed = false;
  let draining = false;       // handing rooms over: refuse binds and events

  const now = () => Date.now();

  function socketsOf(playerId) {
    const ids = io.sockets.adapter.rooms.get(`p:${playerId}`);
    return ids ? [...ids].map((id) => io.sockets.sockets.get(id)).filter(Boolean) : [];
  }

  function markDirty(room) {
    if (room) dirty.add(room.code);
  }

  function bind(socket, room, player) {
    unbind(socket);
    socket.data.seat = { code: room.code, playerId: player.id, tokenHash: player.tokenHash };
    socket.join(`p:${player.id}`);
    socket.join(`r:${room.code}`);
    // A seat that comes back online can't be taken over.
    const refused = lobby.connect(room, player, now());
    for (const r of refused) tellReclaim(r.socketId, { ok: false, reason: `${player.name} is back online` });
    forced.add(socket);
    markDirty(room);
  }

  function unbind(socket) {
    const seat = socket.data.seat;
    if (!seat) return;
    socket.data.seat = null;
    socket.leave(`p:${seat.playerId}`);
    socket.leave(`r:${seat.code}`);
    const room = rooms.get(seat.code);
    const player = room && lobby.findPlayer(room, seat.playerId);
    if (player) lobby.disconnect(room, player, now());
    markDirty(room);
  }

  // The caller's seat, or NOT_IN_ROOM.
  function seatOf(socket) {
    const seat = socket.data.seat;
    if (!seat) throw new RoomError('NOT_IN_ROOM', 'Join a room first');
    const room = rooms.get(seat.code);
    const player = room && lobby.findPlayer(room, seat.playerId);
    if (!player || player.left || player.tokenHash !== seat.tokenHash) {
      unbind(socket);
      throw new RoomError('NOT_IN_ROOM', 'You are no longer in this room');
    }
    return { room, player };
  }

  function tellReclaim(socketId, result) {
    io.to(socketId).emit('reclaim:result', result);
  }

  function snapshotBody(room, playerId) {
    const isHost = room.hostId === playerId;
    const game = room.game && G ? G.viewFor(room.game, playerId, { isHost, isOnline: lobby.isOnlineIn(room) }) : null;
    return { room: lobby.roomView(room, playerId), game };
  }

  // Sends each connected player of every changed room a fresh snapshot, but only when that
  // player's snapshot really changed, so nobody's phone stirs when someone else acts at night.
  function flush() {
    if (closed) return;
    const codes = [...dirty];
    dirty.clear();
    const force = new Set(forced);
    forced.clear();
    for (const code of codes) {
      const room = rooms.get(code);
      if (!room) continue;
      for (const p of room.players) {
        const sockets = socketsOf(p.id).filter((s) => s.data.seat && s.data.seat.code === code);
        if (!sockets.length) continue;
        let body;
        try {
          body = snapshotBody(room, p.id);
        } catch (e) {
          console.error(`[room ${code}] snapshot for ${p.id} failed:`, e);
          continue;
        }
        const json = JSON.stringify(body);
        const key = `${code}/${p.id}`;
        const snap = { serverNow: now(), ...body };
        if (lastSent.get(key) !== json) {
          lastSent.set(key, json);
          io.to(`p:${p.id}`).emit('state', snap);
        } else {
          for (const s of sockets) if (force.has(s)) s.emit('state', snap);
        }
      }
      schedule(room);
      scheduleSave(room);
    }
  }

  // One timeout per room, for the earliest of its deadlines (lobby countdown, host hand-off, game).
  function schedule(room) {
    if (closed || draining) return;
    const code = room.code;
    let at = null;
    try {
      at = rooms.get(code) === room ? lobby.nextDeadline(room) : null;
    } catch (e) {
      console.error(`[room ${code}] nextDeadline failed:`, e);
    }
    if (at != null && (spins.get(code) || 0) > 20) at = Math.max(at, now() + 1000); // back off a stuck deadline
    const current = timers.get(code);
    if (current && current.at === at) return;
    if (current) clearTimeout(current.handle);
    if (at == null) {
      timers.delete(code);
      return;
    }
    const handle = setTimeout(() => fire(code), Math.max(0, at - now()));
    handle.unref();
    timers.set(code, { at, handle });
  }

  function fire(code) {
    timers.delete(code);
    const room = rooms.get(code);
    if (!room || closed || draining) return;
    let stuck = 0;
    try {
      lobby.onDeadline(room, now());
      const next = lobby.nextDeadline(room);
      if (next != null && next <= now()) stuck = (spins.get(code) || 0) + 1;
    } catch (e) {
      console.error(`[room ${code}] deadline failed:`, e);
      stuck = 99;
    }
    if (stuck === 21) console.error(`[room ${code}] a deadline keeps firing without moving on; backing off`);
    if (stuck) spins.set(code, stuck);
    else spins.delete(code);
    markDirty(room);
    flush();
  }

  // Forgets a deleted room: its timer, cached snapshots, bound sockets and waiting takeovers.
  function dropRoom(room, reason) {
    const current = timers.get(room.code);
    if (current) clearTimeout(current.handle);
    timers.delete(room.code);
    spins.delete(room.code);
    rooms.delete(room.code);
    forgetRoom(room.code, { deleteSnapshot: true });
    for (const r of room.reclaims) tellReclaim(r.socketId, { ok: false, reason: 'The room was closed' });
    for (const p of room.players) {
      lastSent.delete(`${room.code}/${p.id}`);
      for (const s of socketsOf(p.id)) {
        if (!s.data.seat || s.data.seat.code !== room.code) continue;
        s.data.seat = null;
        s.leave(`p:${p.id}`);
        s.leave(`r:${room.code}`);
        if (reason) s.emit('kicked', { reason });
      }
    }
  }

  // Sliding one-second window per socket.
  function limited(socket) {
    const t = now();
    const hits = socket.data.hits || (socket.data.hits = []);
    while (hits.length && t - hits[0] >= RATE_WINDOW_MS) hits.shift();
    if (hits.length >= RATE_LIMIT) return true;
    hits.push(t);
    return false;
  }

  function errorReply(e, event) {
    const gameError = !!(G && G.GameError && e instanceof G.GameError);
    if (e && typeof e.code === 'string' && (e instanceof RoomError || gameError) && KNOWN_CODES.has(e.code)) {
      return { ok: false, error: e.message, code: e.code };
    }
    console.error(`[${event}]`, e);
    return { ok: false, error: 'Something went wrong on the server', code: 'BAD_REQUEST' };
  }

  // Registers a client event: rate limit, payload check, then `{ ok: true, ...extra }` or an error ack.
  // Handlers may be async (restoring a room from the store). The ack goes out first, then the
  // fresh snapshots. While rooms are being handed over, everything answers RETRY.
  function on(socket, event, handler) {
    socket.on(event, async (...args) => {
      const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      let payload = args[0];
      let res;
      if (limited(socket)) {
        res = { ok: false, error: 'Too many taps at once; try again in a second', code: 'RATE_LIMITED' };
      } else if (draining) {
        res = { ok: false, error: RETRY_MESSAGE, code: 'RETRY' };
      } else {
        try {
          if (payload == null) payload = {};
          if (typeof payload !== 'object' || Array.isArray(payload)) throw new RoomError('BAD_REQUEST', 'Malformed request');
          res = { ok: true, ...((await handler(payload)) || {}) };
        } catch (e) {
          res = errorReply(e, event);
        }
      }
      if (ack) {
        try {
          ack(res);
        } catch (e) {
          console.error(`[${event}] ack failed:`, e);
        }
      }
      try {
        flush();
      } catch (e) {
        console.error(`[${event}] sending snapshots failed:`, e); // never an unhandled rejection
      }
    });
  }

  function hostSeat(socket) {
    const seat = seatOf(socket);
    if (seat.room.hostId !== seat.player.id) throw new RoomError('NOT_HOST', 'Only the host can do that');
    return seat;
  }

  // The caller's seat in the running game.
  function playing(socket) {
    const seat = seatOf(socket);
    if (!seat.room.game || !G) throw new RoomError('NOT_ALLOWED', 'No game is running');
    if (!G.inGame(seat.room.game, seat.player.id)) throw new RoomError('NOT_ALLOWED', "You're not in this game; you'll play the next one");
    return seat;
  }

  function attach(socket) {
    on(socket, 'room:create', async ({ name }) => {
      cleanName(name); // a bad name fails before a code is reserved
      const code = await pickCode();
      let made;
      try {
        made = lobby.create(name, now(), { code });
      } catch (e) {
        if (store) storeOp(code, () => store.delIfEquals(`lease:${code}`, instanceId));
        throw e;
      }
      bind(socket, made.room, made.player);
      return { code: made.room.code, playerId: made.player.id, token: made.token };
    });

    // Join, resume and reclaim may name a room another instance saved: restore it first.
    on(socket, 'room:join', async ({ code, name }) => {
      await ensureRoom(normalizeCode(code));
      const { room, player, token } = lobby.join(code, name, now());
      bind(socket, room, player);
      return { code: room.code, playerId: player.id, token };
    });

    // Also how a player who left the game comes back: binding clears `left`.
    on(socket, 'room:resume', async ({ code, playerId, token }) => {
      await ensureRoom(normalizeCode(code));
      const { room, player } = lobby.checkSeat(code, playerId, token);
      const seat = socket.data.seat;
      if (seat && seat.code === room.code && seat.playerId === player.id && seat.tokenHash === player.tokenHash) {
        forced.add(socket);
        markDirty(room);
      } else {
        bind(socket, room, player);
      }
    });

    on(socket, 'room:reclaim', async ({ code, name }) => {
      await ensureRoom(normalizeCode(code));
      const { room, request } = lobby.requestReclaim(code, name, socket.id, now());
      markDirty(room);
      return { requestId: request.requestId };
    });

    // Lobby: the seat is removed, so its other tabs get seat:invalid. In a game the seat stays
    // valid for a rejoin, so other tabs are just disconnected (the client keeps the seat).
    on(socket, 'room:leave', () => {
      const { room, player } = seatOf(socket);
      const others = socketsOf(player.id).filter((s) => s !== socket);
      unbind(socket);
      for (const s of others) {
        unbind(s);
        if (room.game) s.disconnect(true);
        else s.emit('seat:invalid', {});
      }
      const out = lobby.leave(room, player.id, now());
      lastSent.delete(`${room.code}/${player.id}`);
      for (const r of out.refused) tellReclaim(r.socketId, { ok: false, reason: `${player.name} left` });
      if (out.deleted) dropRoom(room);
      else markDirty(room);
    });

    on(socket, 'lobby:ready', ({ ready }) => {
      const { room, player } = seatOf(socket);
      lobby.setReady(room, player.id, ready, now());
      markDirty(room);
    });

    on(socket, 'lobby:settings', ({ patch }) => {
      const { room, player } = seatOf(socket);
      lobby.updateSettings(room, player.id, patch, now());
      markDirty(room);
    });

    on(socket, 'lobby:shuffle', () => {
      const { room, player } = seatOf(socket);
      lobby.shuffle(room, player.id, now());
      markDirty(room);
    });

    on(socket, 'lobby:kick', ({ playerId }) => {
      const { room, player } = seatOf(socket);
      const out = lobby.kick(room, player.id, playerId, now());
      for (const s of socketsOf(out.player.id)) {
        if (!s.data.seat || s.data.seat.code !== room.code) continue;
        unbind(s);
        s.emit('kicked', { reason: 'The host removed you from the room' });
      }
      lastSent.delete(`${room.code}/${out.player.id}`);
      for (const r of out.refused) tellReclaim(r.socketId, { ok: false, reason: `${out.player.name} was removed` });
      markDirty(room);
    });

    on(socket, 'host:transfer', ({ playerId }) => {
      const { room, player } = seatOf(socket);
      lobby.transferHost(room, player.id, playerId, now());
      markDirty(room);
    });

    on(socket, 'host:approve-reclaim', ({ requestId, allow }) => {
      const { room, player } = seatOf(socket);
      const out = lobby.approveReclaim(room, player.id, requestId, allow, now(), (id) => io.sockets.sockets.has(id));
      const asker = io.sockets.sockets.get(out.request.socketId);
      if (out.granted) {
        tellReclaim(out.request.socketId, { ok: true, code: room.code, playerId: out.player.id, token: out.token });
        if (asker) bind(asker, room, out.player);
        for (const r of out.others) tellReclaim(r.socketId, { ok: false, reason: 'Someone else took that seat' });
      } else {
        tellReclaim(out.request.socketId, { ok: false, reason: out.reason });
      }
      markDirty(room);
    });

    // Game events go to the engine, which checks them against the caller's task and the phase.
    on(socket, 'game:seen-role', () => {
      const { room, player } = playing(socket);
      G.seenRole(room.game, player.id, now());
      markDirty(room);
    });

    on(socket, 'game:night-action', (payload) => {
      const { room, player } = playing(socket);
      const out = G.nightAction(room.game, player.id, payload, now()) || {};
      markDirty(room);
      return out.result !== undefined ? { result: out.result } : {};
    });

    on(socket, 'game:vote', ({ target }) => {
      const { room, player } = playing(socket);
      G.vote(room.game, player.id, target, now());
      markDirty(room);
    });

    on(socket, 'game:shoot', ({ target }) => {
      const { room, player } = playing(socket);
      G.shoot(room.game, player.id, target, now());
      markDirty(room);
    });

    on(socket, 'host:advance', ({ action }) => {
      const { room } = hostSeat(socket);
      if (!room.game || !G) throw new RoomError('NOT_ALLOWED', 'No game is running');
      if (typeof action !== 'string') throw new RoomError('BAD_REQUEST', 'Send { action }');
      G.hostAction(room.game, action, now(), { isOnline: lobby.isOnlineIn(room) });
      markDirty(room);
    });

    on(socket, 'host:end-game', () => {
      const { room, player } = seatOf(socket);
      lobby.endGame(room, player.id, now());
      markDirty(room);
    });

    on(socket, 'host:play-again', () => {
      const { room, player } = seatOf(socket);
      lobby.playAgain(room, player.id, now());
      markDirty(room);
    });
  }

  // ---------------------------------------------------------------- surviving restarts

  const roomKey = (code) => `room:${code}`;
  const leaseKey = (code) => `lease:${code}`;
  const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref(); });
  const retry = (message = RETRY_MESSAGE) => new RoomError('RETRY', message);
  let lastStoreWarn = 0;
  function storeWarn(what, e) {
    if (now() - lastStoreWarn < 10000) return;
    lastStoreWarn = now();
    console.warn(`[store] ${what}: ${e && e.message ? e.message : e}`);
  }

  // Runs a store operation for a room after the ones queued before it, so writes land in order.
  function storeOp(code, op) {
    const next = (chains.get(code) || Promise.resolve()).then(op).catch((e) => storeWarn(`room ${code}`, e));
    chains.set(code, next);
    next.then(() => { if (chains.get(code) === next) chains.delete(code); });
    return next;
  }

  const phaseKey = (room) => (room.game ? `${room.game.phase}/${room.game.round}/${room.game.day ? room.game.day.stage : ''}` : 'lobby');

  // Debounced snapshot write: about a second after a change, at most saveMaxDelayMs after the
  // first unsaved one. A phase or stage change (game over included) is written at once.
  function scheduleSave(room) {
    if (!store || closed || draining || rooms.get(room.code) !== room) return;
    if (phaseKey(room) !== savedPhase.get(room.code)) {
      saveNow(room);
      return;
    }
    const t = now();
    const pending = saves.get(room.code);
    const firstAt = pending ? pending.firstAt : t;
    if (pending) clearTimeout(pending.timer);
    const timer = setTimeout(() => saveNow(room), Math.max(0, Math.min(cfg.saveDebounceMs, firstAt + cfg.saveMaxDelayMs - t)));
    timer.unref();
    saves.set(room.code, { timer, firstAt });
  }

  function saveNow(room) {
    if (!store) return Promise.resolve();
    const code = room.code;
    const pending = saves.get(code);
    if (pending) clearTimeout(pending.timer);
    saves.delete(code);
    savedPhase.set(code, phaseKey(room));
    return storeOp(code, async () => {
      if (rooms.get(code) !== room) return; // deleted or handed over meanwhile
      const t = now();
      await store.set(roomKey(code), JSON.stringify(lobby.serializeRoom(room, t)), { ttlMs: cfg.roomTtlMs });
      savedAt.set(code, t);
    });
  }

  // A room left this instance: deleted (its snapshot goes too) or handed over (the snapshot stays).
  function forgetRoom(code, { deleteSnapshot }) {
    const pending = saves.get(code);
    if (pending) clearTimeout(pending.timer);
    saves.delete(code);
    savedPhase.delete(code);
    savedAt.delete(code);
    if (!store) return Promise.resolve();
    return storeOp(code, async () => {
      if (deleteSnapshot) await store.del(roomKey(code));
      await store.delIfEquals(leaseKey(code), instanceId);
    });
  }

  // Takes or refreshes this instance's lease on a room; false while another instance holds it.
  async function acquireLease(code) {
    if (!store) return true;
    const holder = await store.get(leaseKey(code));
    if (holder === instanceId) return store.set(leaseKey(code), instanceId, { ttlMs: cfg.leaseMs });
    if (holder != null) return false;
    return store.set(leaseKey(code), instanceId, { ttlMs: cfg.leaseMs, nx: true });
  }

  // The room with this code, restored from the store if it isn't in memory. Null when there is no
  // such room; throws RETRY while another instance holds it, during a handover, or if the store
  // can't be reached.
  async function ensureRoom(code) {
    if (draining) throw retry();
    const existing = rooms.get(code);
    if (existing || !store) return existing || null;
    if (!restoring.has(code)) restoring.set(code, restore(code).finally(() => restoring.delete(code)));
    return restoring.get(code);
  }

  async function restore(code) {
    let raw;
    try {
      if (!(await acquireLease(code))) throw retry('This room is moving to a new server; try again in a moment');
      raw = await store.get(roomKey(code));
    } catch (e) {
      if (e instanceof RoomError) throw e;
      storeWarn(`restoring room ${code}`, e);
      throw retry();
    }
    if (rooms.has(code)) return rooms.get(code);
    let room = null;
    if (raw && !draining && !closed) {
      try {
        room = lobby.restoreRoom(JSON.parse(raw), now());
      } catch (e) {
        console.error(`[store] room ${code} has an unreadable snapshot:`, e);
      }
    }
    if (!room) {
      storeOp(code, () => store.delIfEquals(leaseKey(code), instanceId));
      if (draining || closed) throw retry();
      return null;
    }
    savedPhase.set(code, phaseKey(room));
    savedAt.set(code, now());
    console.log(`[store] restored room ${code} (${room.game ? `${room.game.phase}, round ${room.game.round}` : 'lobby'})`);
    markDirty(room);
    return room;
  }

  // A room code that is free here and in the store, leased to this instance.
  async function pickCode() {
    if (draining) throw retry();
    for (let i = 0; i < 25; i++) {
      let code = '';
      for (let j = 0; j < 4; j++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (rooms.has(code) || restoring.has(code)) continue;
      if (!store) return code;
      try {
        if (!(await acquireLease(code))) continue;
        if ((await store.get(roomKey(code))) != null || rooms.has(code)) {
          storeOp(code, () => store.delIfEquals(leaseKey(code), instanceId));
          continue;
        }
        return code;
      } catch (e) {
        storeWarn('checking a new room code', e);
        if (!rooms.has(code)) return code; // store down: unique in memory is the best we can do
      }
    }
    throw new RoomError('SERVER_FULL', 'No free room code right now; try again');
  }

  // Another instance took a room over (this one stalled past its lease): drop it here and send
  // its phones to reconnect.
  function evictRoom(room, message) {
    const code = room.code;
    const current = timers.get(code);
    if (current) clearTimeout(current.handle);
    timers.delete(code);
    spins.delete(code);
    rooms.delete(code);
    forgetRoom(code, { deleteSnapshot: false });
    for (const p of room.players) {
      lastSent.delete(`${code}/${p.id}`);
      for (const s of socketsOf(p.id)) {
        if (!s.data.seat || s.data.seat.code !== code) continue;
        s.data.seat = null;
        s.emit('server:restarting', { message, reconnectInMs: 2000 });
        setTimeout(() => s.disconnect(true), 100).unref();
      }
    }
  }

  let renewing = false;
  async function renewLeases() {
    if (!store || closed || draining || renewing) return;
    renewing = true;
    try {
      for (const room of [...rooms.values()]) {
        if (closed || draining) return;
        const held = await acquireLease(room.code);
        if (rooms.get(room.code) !== room || closed || draining) continue;
        if (!held) {
          console.warn(`[store] another instance took over room ${room.code}`);
          evictRoom(room, HANDOVER_NOTICE.message);
        } else if (now() - (savedAt.get(room.code) || 0) > SNAPSHOT_REFRESH_MS) {
          saveNow(room); // keeps an idle room's snapshot from expiring
        }
      }
    } catch (e) {
      storeWarn('renewing leases', e);
    } finally {
      renewing = false;
    }
  }
  const leaseTimer = store ? setInterval(renewLeases, cfg.leaseRenewMs) : null;
  if (leaseTimer) leaseTimer.unref();

  // Hands every room to the next instance: stop the clocks, write every room, release the leases,
  // tell every phone to reconnect, and refuse binds from then on.
  let handingOver = null;
  function handover(notice = HANDOVER_NOTICE) {
    if (handingOver) return handingOver;
    draining = true;
    handingOver = (async () => {
      for (const t of timers.values()) clearTimeout(t.handle);
      timers.clear();
      const list = [...rooms.values()];
      await Promise.all(list.map((room) => saveNow(room)));
      await Promise.all(list.map((room) => forgetRoom(room.code, { deleteSnapshot: false })));
      for (const room of list) {
        rooms.delete(room.code);
        for (const p of room.players) lastSent.delete(`${room.code}/${p.id}`);
      }
      io.emit('server:restarting', notice);
      await sleep(250);
      io.disconnectSockets(true);
      console.log(`[deploy] instance ${instanceId} handed over ${list.length} room${list.length === 1 ? '' : 's'}`);
    })();
    return handingOver;
  }

  // Deploys: the newest instance writes its id to deploy:latest at boot. An older instance that
  // sees someone else's id there waits handoverDelayMs (so the new one is taking traffic), then
  // hands its rooms over.
  let deployTimer = null;
  let handoverTimer = null;
  if (store && durable) {
    let announced = false;
    const announce = () => store.set('deploy:latest', instanceId).then(() => { announced = true; }, (e) => storeWarn('announcing this instance', e));
    announce();
    deployTimer = setInterval(async () => {
      if (closed || draining || handoverTimer) return;
      if (!announced) return announce();
      let latest;
      try {
        latest = await store.get('deploy:latest');
      } catch (e) {
        return storeWarn('looking for a newer instance', e);
      }
      if (!latest || latest === instanceId || closed || draining || handoverTimer) return undefined;
      console.log(`[deploy] instance ${latest} is newer; handing rooms over in ${cfg.handoverDelayMs} ms`);
      handoverTimer = setTimeout(() => handover().catch((e) => console.error('[deploy] handover failed:', e)), cfg.handoverDelayMs);
      handoverTimer.unref();
      return undefined;
    }, cfg.deployPollMs);
    deployTimer.unref();
  }

  // Handshake: a saved seat in `auth` rebinds the socket on connect, restoring its room from the
  // store if needed (binding a seat that left the game brings it back). A stale seat gets
  // seat:invalid. A room another instance still runs, or a handover in progress, gets
  // server:restarting and a disconnect, and the phone tries again a little later.
  io.use(async (socket, next) => {
    socket.data.hits = [];
    socket.data.seat = null;
    if (draining) {
      socket.data.restarting = HANDOVER_NOTICE;
      return next();
    }
    const auth = socket.handshake.auth;
    if (auth && typeof auth === 'object' && (auth.code != null || auth.playerId != null || auth.token != null)) {
      try {
        await ensureRoom(normalizeCode(auth.code));
        const { room, player } = lobby.checkSeat(auth.code, auth.playerId, auth.token);
        socket.data.resume = { code: room.code, playerId: player.id, tokenHash: player.tokenHash };
      } catch (e) {
        if (e && e.code === 'RETRY') socket.data.restarting = { message: e.message, reconnectInMs: 2000 };
        else socket.data.seatInvalid = true;
      }
    }
    return next();
  });

  io.on('connection', (socket) => {
    if (socket.data.restarting || draining) {
      socket.emit('server:restarting', socket.data.restarting || HANDOVER_NOTICE);
      setTimeout(() => socket.disconnect(true), 100).unref();
      return;
    }
    attach(socket);
    socket.on('disconnect', () => {
      unbind(socket);
      for (const room of lobby.cancelReclaims(socket.id)) markDirty(room);
      flush();
    });
    const want = socket.data.resume;
    if (want) {
      const room = rooms.get(want.code);
      const player = room && lobby.findPlayer(room, want.playerId);
      if (player && player.tokenHash === want.tokenHash) {
        bind(socket, room, player);
        flush();
        return;
      }
    }
    if (want || socket.data.seatInvalid) socket.emit('seat:invalid', {});
  });

  const sweepTimer = setInterval(() => {
    for (const { room, reason } of lobby.sweep(now())) dropRoom(room, reason);
  }, sweepMs);
  sweepTimer.unref();

  // Self-ping through the public URL so Render's free tier never sees a quiet 15 minutes.
  let keepAliveTimer = null;
  const externalUrl = process.env.RENDER_EXTERNAL_URL;
  if (externalUrl) {
    const target = `${externalUrl.replace(/\/+$/, '')}/healthz`;
    let pings = 0;
    keepAliveTimer = setInterval(async () => {
      pings += 1;
      try {
        const res = await fetch(target, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'werewolf-keep-alive' } });
        await res.text();
        if (!res.ok) console.warn(`[keep-alive] ping ${pings} to ${target} answered HTTP ${res.status}`);
        else if (pings % 10 === 0) console.log(`[keep-alive] ${pings} pings sent to ${target}; the latest answered ${res.status}`);
      } catch (e) {
        console.warn(`[keep-alive] ping ${pings} to ${target} failed: ${e.message}`);
      }
    }, keepAliveMs);
    keepAliveTimer.unref();
  }

  function listen(port = 0, host) {
    return new Promise((resolve, reject) => {
      const onError = (e) => reject(e);
      httpServer.once('error', onError);
      const done = () => {
        httpServer.off('error', onError);
        resolve(httpServer.address().port);
      };
      if (host) httpServer.listen(port, host, done);
      else httpServer.listen(port, done);
    });
  }

  // Stops the keep-alive, the sweep, the lease and deploy timers and every room timer, writes every
  // room still here and releases its lease (so another server can take it), then closes io, the
  // HTTP server and a store this server created.
  let closing = null;
  function close() {
    if (closing) return closing;
    closed = true;
    for (const t of [sweepTimer, keepAliveTimer, leaseTimer, deployTimer]) if (t) clearInterval(t);
    if (handoverTimer) clearTimeout(handoverTimer);
    for (const t of timers.values()) clearTimeout(t.handle);
    timers.clear();
    closing = (async () => {
      if (handingOver) {
        await handingOver.catch(() => {});
      } else if (store && rooms.size) {
        const list = [...rooms.values()];
        const flushed = Promise.all(list.map((room) => saveNow(room).then(() => forgetRoom(room.code, { deleteSnapshot: false }))));
        await Promise.race([flushed, sleep(3000)]);
      }
      for (const s of saves.values()) clearTimeout(s.timer);
      saves.clear();
      await io.close();
      if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections();
      if (store && ownsStore) await store.close().catch(() => {});
    })();
    return closing;
  }

  // SIGTERM (a Render restart or deploy). With a durable store the rooms are handed over and
  // phones get server:restarting; without one the games end and phones get server:shutdown.
  async function shutdown(message) {
    if (durable) {
      await handover(message ? { ...HANDOVER_NOTICE, message } : HANDOVER_NOTICE);
    } else if (!closed) {
      io.emit('server:shutdown', { message: message || 'The server is restarting; this game has ended' });
      await sleep(300);
    }
    await close();
  }

  return { httpServer, io, app, rooms, lobby, store, instanceId, listen, close, shutdown, handover };
}

module.exports = { createServer, createApp, cryptoRandom };

if (require.main === module) {
  // Redis (Render Key Value) when REDIS_URL is set, else one JSON file per key in STORE_DIR or .data/.
  const store = createDefaultStore();
  const srv = createServer({ store, ownStore: true });
  console.log(`Room store: ${store.kind}${store.dir ? ` in ${store.dir}` : ''}; instance ${srv.instanceId}`);
  const port = Number(process.env.PORT) || 3000;
  srv.listen(port, '0.0.0.0').then((p) => {
    console.log(`Werewolf listening on http://0.0.0.0:${p}`);
  }, (e) => {
    console.error('Could not start the server:', e);
    process.exit(1);
  });
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received: ${store.durable ? 'handing rooms over' : 'telling every phone'} and shutting down`);
    srv.shutdown().catch((e) => console.error('Shutdown failed:', e)).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
