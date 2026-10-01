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
const { G, RoomError, createRooms, CODE_RE } = require('./src/rooms');

const RATE_LIMIT = 10;          // events per socket per second
const RATE_WINDOW_MS = 1000;
const KEEP_ALIVE_MS = 150000;   // 2.5 minutes, as cultfit-agent does
const SWEEP_MS = 5 * 60 * 1000;
const KNOWN_CODES = new Set(['NO_ROOM', 'ROOM_FULL', 'NAME_TAKEN', 'NAME_TAKEN_OFFLINE', 'BAD_NAME', 'BAD_CODE', 'BAD_SEAT',
  'NOT_IN_ROOM', 'NOT_HOST', 'NOT_ALLOWED', 'BAD_TARGET', 'BAD_SETTINGS', 'RATE_LIMITED', 'SERVER_FULL', 'BAD_REQUEST']);

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
  let closed = false;

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
    socket.data.seat = { code: room.code, playerId: player.id, token: player.token };
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
    if (!player || player.left || player.token !== seat.token) {
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
    }
  }

  // One timeout per room, for the earliest of its deadlines (lobby countdown, host hand-off, game).
  function schedule(room) {
    if (closed) return;
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
    if (!room || closed) return;
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
  // The ack goes out first, then the fresh snapshots.
  function on(socket, event, handler) {
    socket.on(event, (...args) => {
      const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      let payload = args[0];
      let res;
      if (limited(socket)) {
        res = { ok: false, error: 'Too many taps at once; try again in a second', code: 'RATE_LIMITED' };
      } else {
        try {
          if (payload == null) payload = {};
          if (typeof payload !== 'object' || Array.isArray(payload)) throw new RoomError('BAD_REQUEST', 'Malformed request');
          res = { ok: true, ...(handler(payload) || {}) };
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
      flush();
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
    on(socket, 'room:create', ({ name }) => {
      const { room, player } = lobby.create(name, now());
      bind(socket, room, player);
      return { code: room.code, playerId: player.id, token: player.token };
    });

    on(socket, 'room:join', ({ code, name }) => {
      const { room, player } = lobby.join(code, name, now());
      bind(socket, room, player);
      return { code: room.code, playerId: player.id, token: player.token };
    });

    on(socket, 'room:resume', ({ code, playerId, token }) => {
      const { room, player } = lobby.checkSeat(code, playerId, token);
      const seat = socket.data.seat;
      if (seat && seat.code === room.code && seat.playerId === player.id && seat.token === player.token) {
        forced.add(socket);
        markDirty(room);
      } else {
        bind(socket, room, player);
      }
    });

    on(socket, 'room:reclaim', ({ code, name }) => {
      const { room, request } = lobby.requestReclaim(code, name, socket.id, now());
      markDirty(room);
      return { requestId: request.requestId };
    });

    on(socket, 'room:leave', () => {
      const { room, player } = seatOf(socket);
      const others = socketsOf(player.id).filter((s) => s !== socket);
      unbind(socket);
      for (const s of others) {
        unbind(s);
        s.emit('seat:invalid', {});
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

  // Handshake: a saved seat in `auth` rebinds the socket on connect; a stale one gets seat:invalid.
  io.use((socket, next) => {
    socket.data.hits = [];
    socket.data.seat = null;
    const auth = socket.handshake.auth;
    if (auth && typeof auth === 'object' && (auth.code != null || auth.playerId != null || auth.token != null)) {
      try {
        const { room, player } = lobby.checkSeat(auth.code, auth.playerId, auth.token);
        socket.data.resume = { code: room.code, playerId: player.id, token: player.token };
      } catch (e) {
        socket.data.seatInvalid = true;
      }
    }
    next();
  });

  io.on('connection', (socket) => {
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
      if (player && !player.left && player.token === want.token) {
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

  // Stops the keep-alive, the sweep and every room timer, then closes io and the HTTP server.
  let closing = null;
  function close() {
    if (closing) return closing;
    closed = true;
    clearInterval(sweepTimer);
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    for (const t of timers.values()) clearTimeout(t.handle);
    timers.clear();
    closing = io.close().then(() => {
      if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections();
    });
    return closing;
  }

  // SIGTERM (a Render restart or deploy): tell every phone, give the message a moment, then close.
  async function shutdown(message = 'The server is restarting; this game has ended') {
    if (!closed) {
      io.emit('server:shutdown', { message });
      await new Promise((r) => setTimeout(r, 300));
    }
    await close();
  }

  return { httpServer, io, app, rooms, lobby, listen, close, shutdown };
}

module.exports = { createServer, createApp, cryptoRandom };

if (require.main === module) {
  const srv = createServer();
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
    console.log(`${signal} received: telling every phone and shutting down`);
    srv.shutdown().catch((e) => console.error('Shutdown failed:', e)).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
