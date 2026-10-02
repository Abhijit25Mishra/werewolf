'use strict';
// Room store and lobby logic (PLAN.md section 7, docs/PROTOCOL.md): room codes, seats and tokens,
// names, the host, ready-up and its countdown, settings, the auto deck, reclaims and cleanup.
// No sockets here: server.js binds sockets and sends snapshots. Stored state is plain JSON.
const crypto = require('crypto');
const R = require('./roles');

// The rules engine lives in src/game.js. Without it the lobby still works, but games can't start.
let G = null;
try {
  G = require('./game');
} catch (e) {
  if (!(e && e.code === 'MODULE_NOT_FOUND' && String(e.message).startsWith("Cannot find module './game'"))) throw e;
  console.warn('[rooms] src/game.js is missing: games cannot start');
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;
const MAX_NAME_LENGTH = 16;
const MAX_ROOMS = 200;
const COUNTDOWN_MS = 5000;              // lobby countdown once everyone is ready
const HOST_GRACE_MS = 60000;            // host offline this long before host passes on
const CLEANUP_MS = 30 * 60 * 1000;      // a room nobody is connected to is deleted after this
const ROOM_LIFETIME_MS = 12 * 60 * 60 * 1000;
const MAX_RECLAIMS = 20;                // pending seat takeover requests per room

class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new RoomError(code, message);
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const randomId = () => crypto.randomBytes(9).toString('base64url'); // 12 characters
const newToken = () => crypto.randomBytes(16).toString('hex');      // 32 hex characters
const nameKey = (name) => name.toLowerCase();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Rooms keep only a SHA-256 of each seat token; the raw token goes to the player's device alone.
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// Whether a raw token from a client matches a stored hash, in constant time.
function tokenMatches(hash, token) {
  if (typeof hash !== 'string' || typeof token !== 'string' || !token || token.length > 128) return false;
  const given = hashToken(token);
  return hash.length === given.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(given));
}

const SNAPSHOT_VERSION = 1;

function normalizeCode(raw) {
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!CODE_RE.test(code)) fail('BAD_CODE', 'Room codes are 4 letters');
  return code;
}

function cleanName(raw) {
  if (typeof raw !== 'string') fail('BAD_NAME', 'Enter a name');
  const name = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  const length = Array.from(name).length;
  if (!length) fail('BAD_NAME', 'Enter a name');
  if (length > MAX_NAME_LENGTH) fail('BAD_NAME', `Names can be at most ${MAX_NAME_LENGTH} characters`);
  if (/\p{Cc}/u.test(name)) fail('BAD_NAME', "That name has characters that can't be shown");
  return name;
}

function defaultSettings() {
  return {
    roleMode: 'auto',
    allowedRoles: R.ROLE_IDS.slice(),
    balanceTilt: 'balanced',
    roles: {},
    reveal: 'role',
    firstNightKill: true,
    deadSeeRoles: false,
    voteStyle: 'secret',
    discussionSeconds: 180,
    voteSeconds: 60,
    nightSeconds: 90,
    nightMinSeconds: 20,
  };
}
const SETTING_KEYS = Object.keys(defaultSettings());

// Role counts in display order, without zeros, so two decks compare as JSON.
function normRoles(roles) {
  const out = {};
  for (const id of R.ROLE_IDS) {
    const n = roles ? roles[id] : 0;
    if (Number.isInteger(n) && n > 0) out[id] = n;
  }
  return out;
}
const sameRoles = (a, b) => JSON.stringify(normRoles(a)) === JSON.stringify(normRoles(b));

function badSettings(message) {
  fail('BAD_SETTINGS', message);
}

function oneOf(key, value, options) {
  if (!options.includes(value)) badSettings(`${key} must be one of ${options.join(', ')}`);
  return value;
}

function intIn(key, value, lo, hi) {
  if (!Number.isInteger(value) || value < lo || value > hi) badSettings(`${key} must be a whole number from ${lo} to ${hi}`);
  return value;
}

// Validates one setting from a patch and returns its stored form.
function validateSetting(key, value) {
  switch (key) {
    case 'roleMode': return oneOf(key, value, ['auto', 'manual']);
    case 'balanceTilt': return oneOf(key, value, ['village', 'balanced', 'wolves']);
    case 'reveal': return oneOf(key, value, ['role', 'day', 'team', 'wolf', 'none']);
    case 'voteStyle': return oneOf(key, value, ['secret', 'live']);
    case 'firstNightKill':
    case 'deadSeeRoles':
      if (typeof value !== 'boolean') badSettings(`${key} must be true or false`);
      return value;
    case 'allowedRoles': {
      if (!Array.isArray(value) || value.length > 64) badSettings('allowedRoles must be a list of role ids');
      for (const id of value) if (!R.isRole(id)) badSettings(`Unknown role: ${String(id).slice(0, 20)}`);
      const allowed = new Set([...value, ...R.ALWAYS_ALLOWED]);
      return R.ROLE_IDS.filter((id) => allowed.has(id));
    }
    case 'roles': {
      if (!isObject(value)) badSettings('roles must map role ids to counts');
      for (const [id, n] of Object.entries(value)) {
        if (!R.isRole(id)) badSettings(`Unknown role: ${id.slice(0, 20)}`);
        const info = R.ROLE_BY_ID[id];
        if (!Number.isInteger(n) || n < 0 || n > info.max) badSettings(`${info.name}: 0 to ${info.max}`);
      }
      return normRoles(value);
    }
    case 'discussionSeconds':
      if (value === 0) return 0;
      return intIn(key, value, 30, 600);
    case 'voteSeconds': return intIn(key, value, 15, 180);
    case 'nightSeconds': return intIn(key, value, 30, 300);
    case 'nightMinSeconds': return intIn(key, value, 0, 60);
    default: return badSettings(`Unknown setting: ${String(key).slice(0, 30)}`);
  }
}

// Applies a patch to a copy of the settings; throws BAD_SETTINGS and changes nothing on any bad field.
function mergeSettings(current, patch) {
  if (!isObject(patch)) fail('BAD_REQUEST', 'Send the settings to change as { patch: {...} }');
  const next = clone(current);
  for (const key of Object.keys(patch)) {
    if (!SETTING_KEYS.includes(key)) badSettings(`Unknown setting: ${key.slice(0, 30)}`);
    next[key] = validateSetting(key, patch[key]);
  }
  if (next.nightMinSeconds > next.nightSeconds) badSettings('nightMinSeconds must not exceed nightSeconds');
  // Manual counts are ignored in auto mode, where the dealt deck fills them in.
  if (next.roleMode === 'auto') next.roles = clone(current.roles);
  return next;
}

// What the status line says when a game can't start, for this many players and this deck.
function deckProblem(roles, playerCount) {
  const errors = R.validateDeck(roles, playerCount);
  if (!errors.length) return null;
  const total = R.countTotal(roles);
  if (total !== playerCount) return `Roles add up to ${total} but there ${playerCount === 1 ? 'is' : 'are'} ${plural(playerCount, 'player')}`;
  return errors[0];
}

// The room store. Options: minPlayers, timeScale (divides the countdown and the host grace),
// rng (deck building and dealing), cleanupMs, maxRooms.
function createRooms(options = {}) {
  const timeScale = options.timeScale > 0 ? options.timeScale : 1;
  const minPlayers = Math.max(1, Math.min(R.MAX_PLAYERS, Math.floor(options.minPlayers || R.MIN_PLAYERS)));
  const rng = options.rng || Math.random;
  const cleanupMs = options.cleanupMs >= 0 ? options.cleanupMs : CLEANUP_MS;
  const maxRooms = options.maxRooms > 0 ? options.maxRooms : MAX_ROOMS;
  const countdownMs = Math.round(COUNTDOWN_MS / timeScale);
  const hostGraceMs = Math.round(HOST_GRACE_MS / timeScale);
  const rooms = new Map();

  const findPlayer = (room, id) => room.players.find((p) => p.id === id) || null;
  const seatedPlayers = (room) => room.players.filter((p) => !p.left); // everyone who plays the next game
  const online = (p) => !!p && !p.left && p.sockets > 0;
  const clearReady = (room) => { for (const p of room.players) p.ready = false; };

  function getRoom(rawCode) {
    const code = normalizeCode(rawCode);
    const room = rooms.get(code);
    if (!room) fail('NO_ROOM', `No room called ${code}`);
    return room;
  }

  function seated(room, playerId) {
    const p = findPlayer(room, playerId);
    if (!p || p.left) fail('NOT_IN_ROOM', 'You are not in this room');
    return p;
  }

  function requireHost(room, playerId) {
    if (room.hostId !== playerId) fail('NOT_HOST', 'Only the host can do that');
  }

  function requireLobby(room) {
    if (room.game) fail('NOT_ALLOWED', 'Not while a game is on');
  }

  function newCode() {
    for (let i = 0; i < 200; i++) {
      let code = '';
      for (let j = 0; j < 4; j++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
    return fail('SERVER_FULL', 'No free room codes; try again');
  }

  // A new seat. Returns the raw token for the player's device; the room keeps only its hash.
  function newPlayer(room, name, now) {
    let id = randomId();
    while (findPlayer(room, id)) id = randomId();
    const token = newToken();
    const player = { id, name, tokenHash: hashToken(token), ready: false, sockets: 0, left: false, joinedAt: now };
    room.players.push(player);
    return { player, token };
  }

  // Deals the line-up for the next game. Auto mode builds a balanced deck for the seated players;
  // manual mode scores the host's counts. Clears every ready flag when the deck changes.
  function deal(room) {
    const s = room.settings;
    const n = seatedPlayers(room).length;
    const before = room.deck ? room.deck.roles : null;
    if (s.roleMode === 'auto') {
      const d = R.buildAutoDeck({ playerCount: n, allowedRoles: s.allowedRoles, tilt: s.balanceTilt, reveal: s.reveal, rng });
      const roles = normRoles(d.roles);
      room.deck = { roles, score: d.score, band: d.band, target: d.target, inRange: d.inRange, suggestions: d.suggestions };
      s.roles = clone(roles); // switching to manual starts from the dealt deck
    } else {
      const roles = normRoles(s.roles);
      const score = R.scoreDeck(roles);
      const target = R.targetRange(s.balanceTilt, s.reveal);
      room.deck = { roles, score, band: R.bandOf(score), target, inRange: score >= target[0] && score <= target[1], suggestions: [] };
    }
    room.deckPlayers = n;
    if (!before || !sameRoles(before, room.deck.roles)) clearReady(room);
  }

  // Re-deals when the number of seated players changed since the last deal.
  function ensureDeck(room) {
    if (room.deckPlayers !== seatedPlayers(room).length) deal(room);
  }

  function startStatus(room) {
    if (room.game) return { ok: false, reason: 'A game is in progress' };
    const players = seatedPlayers(room);
    const n = players.length;
    if (n < minPlayers) return { ok: false, reason: `Need at least ${minPlayers} players` };
    if (n > R.MAX_PLAYERS) return { ok: false, reason: `At most ${R.MAX_PLAYERS} players can play` };
    const problem = deckProblem(room.deck.roles, n);
    if (problem) return { ok: false, reason: problem };
    const waiting = players.filter((p) => !p.ready).length;
    if (waiting) return { ok: false, reason: `Waiting for ${plural(waiting, 'player')} to get ready` };
    return { ok: true, reason: null };
  }

  // Call after every lobby change. `changed` cancels a running countdown; it starts again only
  // if everything still holds, which no real change allows, since each one clears a ready flag.
  function refresh(room, now, changed = true) {
    if (changed) room.countdownEndsAt = null;
    if (room.game || !startStatus(room).ok) room.countdownEndsAt = null;
    else if (room.countdownEndsAt == null) room.countdownEndsAt = now + countdownMs;
    room.lastActiveAt = now;
  }

  // `code` may be picked by server.js after checking the store; otherwise a free one is drawn here.
  // Returns the raw seat token for the creator's device.
  function create(rawName, now, { code } = {}) {
    const name = cleanName(rawName);
    if (rooms.size >= maxRooms) fail('SERVER_FULL', 'The server is full right now; try again later');
    if (code && rooms.has(code)) fail('SERVER_FULL', 'That room code was just taken; try again');
    const room = {
      code: code || newCode(),
      hostId: null,
      players: [],
      settings: defaultSettings(),
      deck: null,
      deckPlayers: 0,
      game: null,
      countdownEndsAt: null,
      reclaims: [],
      createdAt: now,
      lastActiveAt: now,
      emptySince: now,       // nobody connected yet; server.js binds the creator right away
      hostOfflineAt: null,
    };
    const { player, token } = newPlayer(room, name, now);
    room.hostId = player.id;
    room.hostOfflineAt = now;
    deal(room);
    refresh(room, now);
    rooms.set(room.code, room);
    return { room, player, token };
  }

  // Joins the lobby, or during a game waits in the list and plays the next game.
  function join(rawCode, rawName, now) {
    const room = getRoom(rawCode);
    const name = cleanName(rawName);
    const same = room.players.find((p) => nameKey(p.name) === nameKey(name));
    if (same) {
      // A seat that left the game counts as offline: its owner can take it back from here.
      if (same.left || same.sockets === 0) fail('NAME_TAKEN_OFFLINE', `${same.name} is offline. Is that you? Ask the host to let you take the seat back`);
      fail('NAME_TAKEN', 'That name is taken in this room');
    }
    if (seatedPlayers(room).length >= R.MAX_PLAYERS) fail('ROOM_FULL', 'This room is full');
    const { player, token } = newPlayer(room, name, now);
    try {
      ensureDeck(room);
    } catch (e) {
      room.players = room.players.filter((p) => p !== player); // no half-made seat
      throw e;
    }
    refresh(room, now);
    return { room, player, token };
  }

  // Checks a saved seat for resume and the socket handshake. A seat that left the game is still
  // valid: binding it brings the player back.
  function checkSeat(rawCode, playerId, token) {
    const room = getRoom(rawCode);
    const player = typeof playerId === 'string' ? findPlayer(room, playerId) : null;
    if (!player || !tokenMatches(player.tokenHash, token)) fail('BAD_SEAT', 'That seat is no longer yours');
    return { room, player };
  }

  // A socket was bound to the seat. Returns reclaim requests refused because the seat came back.
  // Binding a seat that left the game brings the player back into it.
  function connect(room, player, now) {
    player.sockets += 1;
    room.emptySince = null;
    room.lastActiveAt = now;
    if (player.left) {
      player.left = false;
      ensureDeck(room); // they count for the next game again
    }
    if (player.id === room.hostId) room.hostOfflineAt = null;
    const refused = room.reclaims.filter((r) => r.playerId === player.id);
    if (refused.length) room.reclaims = room.reclaims.filter((r) => r.playerId !== player.id);
    return refused;
  }

  // A socket bound to the seat closed or was unbound.
  function disconnect(room, player, now) {
    player.sockets = Math.max(0, player.sockets - 1);
    if (player.sockets === 0 && player.id === room.hostId && room.hostOfflineAt == null) room.hostOfflineAt = now;
    if (!room.players.some((p) => p.sockets > 0) && room.emptySince == null) room.emptySince = now;
    room.lastActiveAt = now;
  }

  function setHost(room, playerId, now) {
    room.hostId = playerId;
    room.hostOfflineAt = online(findPlayer(room, playerId)) ? null : now;
  }

  // Who takes over from an absent host: the longest-joined connected player.
  function hostCandidate(room) {
    return room.players.find((p) => p.id !== room.hostId && online(p)) || null;
  }

  // The host left: pass host on at once, to an offline player if nobody else is connected.
  function passHost(room, now) {
    const next = hostCandidate(room) || room.players.find((p) => p.id !== room.hostId && !p.left);
    if (next) setHost(room, next.id, now);
  }

  function dropReclaimsFor(room, playerId) {
    const dropped = room.reclaims.filter((r) => r.playerId === playerId);
    if (dropped.length) room.reclaims = room.reclaims.filter((r) => r.playerId !== playerId);
    return dropped;
  }

  // Asks to take over an offline seat (or one that left the game) from a new device; the host
  // approves or refuses.
  function requestReclaim(rawCode, rawName, socketId, now) {
    const room = getRoom(rawCode);
    const name = cleanName(rawName);
    const player = room.players.find((p) => nameKey(p.name) === nameKey(name));
    if (!player) fail('BAD_SEAT', `Nobody called ${name} is in this room`);
    if (player.sockets > 0) fail('NAME_TAKEN', `${player.name} is online on another device`);
    room.reclaims = room.reclaims.filter((r) => r.socketId !== socketId); // one request per device
    if (room.reclaims.length >= MAX_RECLAIMS) fail('NOT_ALLOWED', 'Too many takeover requests; try again in a minute');
    const request = { requestId: randomId(), playerId: player.id, name: player.name, socketId, createdAt: now };
    room.reclaims.push(request);
    room.lastActiveAt = now;
    return { room, request };
  }

  // The asking device went away: forget its requests. Returns the rooms that changed.
  function cancelReclaims(socketId) {
    const changed = [];
    for (const room of rooms.values()) {
      const before = room.reclaims.length;
      room.reclaims = room.reclaims.filter((r) => r.socketId !== socketId);
      if (room.reclaims.length !== before) changed.push(room);
    }
    return changed;
  }

  // Approval issues a new token and retires the old one. `canDeliver(socketId)` says whether the
  // asking device is still there; without it the seat would end up with a token nobody holds.
  function approveReclaim(room, hostId, requestId, allow, now, canDeliver = () => true) {
    requireHost(room, hostId);
    if (typeof requestId !== 'string' || typeof allow !== 'boolean') fail('BAD_REQUEST', 'Send { requestId, allow }');
    const request = room.reclaims.find((r) => r.requestId === requestId);
    if (!request) fail('NOT_ALLOWED', 'That request is no longer waiting');
    room.reclaims = room.reclaims.filter((r) => r !== request);
    room.lastActiveAt = now;
    const player = findPlayer(room, request.playerId);
    const refuse = (reason) => ({ request, granted: false, reason, others: [] });
    if (!allow) return refuse('The host said no');
    if (!player) return refuse('That seat is gone');
    if (player.sockets > 0) return refuse(`${player.name} is back online`);
    if (!canDeliver(request.socketId)) return refuse('The device asking went offline');
    const token = newToken();
    player.tokenHash = hashToken(token);
    return { request, granted: true, player, token, others: dropReclaimsFor(room, player.id) };
  }

  // Lobby: the player is removed. In a game: the seat stays, marked left, and its token stays
  // valid, so resuming brings the player back. A host who leaves hands host on at once.
  // Returns { deleted, refused }; only an empty lobby is deleted.
  function leave(room, playerId, now) {
    const player = seated(room, playerId);
    player.ready = false;
    if (room.game) {
      player.left = true;
      player.sockets = 0;
    } else {
      room.players = room.players.filter((p) => p !== player);
    }
    const refused = dropReclaimsFor(room, player.id);
    if (room.hostId === player.id) passHost(room, now);
    if (!room.players.length) {
      rooms.delete(room.code);
      return { deleted: true, refused };
    }
    if (!room.players.some((p) => p.sockets > 0) && room.emptySince == null) room.emptySince = now;
    ensureDeck(room);
    refresh(room, now);
    return { deleted: false, refused };
  }

  function kick(room, hostId, targetId, now) {
    requireHost(room, hostId);
    requireLobby(room);
    if (typeof targetId !== 'string') fail('BAD_REQUEST', 'Send { playerId }');
    if (targetId === hostId) fail('BAD_TARGET', "You can't remove yourself; tap Leave instead");
    const player = findPlayer(room, targetId);
    if (!player) fail('BAD_TARGET', 'That player is not in this room');
    room.players = room.players.filter((p) => p !== player);
    const refused = dropReclaimsFor(room, player.id);
    ensureDeck(room);
    refresh(room, now);
    return { player, refused };
  }

  // Hands host to another connected player, in the lobby or during a game.
  function transferHost(room, hostId, targetId, now) {
    requireHost(room, hostId);
    if (typeof targetId !== 'string') fail('BAD_REQUEST', 'Send { playerId }');
    const player = findPlayer(room, targetId);
    if (!player || player.left || player.id === hostId) fail('BAD_TARGET', 'Pick another player in the room');
    if (!online(player)) fail('BAD_TARGET', `${player.name} is offline`);
    setHost(room, player.id, now);
    room.lastActiveAt = now;
  }

  function setReady(room, playerId, ready, now) {
    const player = seated(room, playerId);
    requireLobby(room);
    if (typeof ready !== 'boolean') fail('BAD_REQUEST', 'Send { ready: true } or { ready: false }');
    if (player.ready === ready) return false;
    player.ready = ready;
    refresh(room, now);
    return true;
  }

  // Validates and applies a settings patch; any real change re-deals and clears every ready flag.
  function updateSettings(room, hostId, patch, now) {
    requireHost(room, hostId);
    requireLobby(room);
    const next = mergeSettings(room.settings, patch);
    if (JSON.stringify(next) === JSON.stringify(room.settings)) return false;
    room.settings = next;
    deal(room);
    clearReady(room);
    refresh(room, now);
    return true;
  }

  function shuffle(room, hostId, now) {
    requireHost(room, hostId);
    requireLobby(room);
    if (room.settings.roleMode !== 'auto') fail('NOT_ALLOWED', 'Shuffle works in auto mode');
    deal(room);
    clearReady(room);
    refresh(room, now);
  }

  // Back to the lobby with the same settings, minus the players who left.
  function backToLobby(room, now) {
    room.game = null;
    room.players = room.players.filter((p) => !p.left);
    if (!findPlayer(room, room.hostId)) passHost(room, now);
    clearReady(room);
    ensureDeck(room);
    refresh(room, now);
  }

  function endGame(room, hostId, now) {
    requireHost(room, hostId);
    if (!room.game) fail('NOT_ALLOWED', 'No game is running');
    backToLobby(room, now);
  }

  function playAgain(room, hostId, now) {
    requireHost(room, hostId);
    if (!room.game || !G || !G.isOver(room.game)) fail('NOT_ALLOWED', 'The game is not over yet');
    backToLobby(room, now);
  }

  // The countdown ended: deal the game. On failure everyone has to ready up again.
  function startGame(room, now) {
    room.countdownEndsAt = null;
    if (!startStatus(room).ok) return false;
    const players = seatedPlayers(room).map((p) => ({ id: p.id, name: p.name }));
    try {
      if (!G) throw new Error('src/game.js is missing');
      room.game = G.createGame({ players, roles: clone(room.deck.roles), settings: clone(room.settings), now, rng, timeScale });
    } catch (e) {
      console.error(`[room ${room.code}] the game could not start:`, e);
      room.game = null;
      clearReady(room);
      return false;
    }
    clearReady(room);
    room.lastActiveAt = now;
    return true;
  }

  // The earliest pending deadline of the room: lobby countdown, host hand-off or a game timer.
  function nextDeadline(room) {
    let at = null;
    const consider = (t) => { if (typeof t === 'number' && (at == null || t < at)) at = t; };
    if (!room.game) consider(room.countdownEndsAt);
    if (room.hostOfflineAt != null && hostCandidate(room)) consider(room.hostOfflineAt + hostGraceMs);
    if (room.game && G) consider(G.nextDeadline(room.game));
    return at;
  }

  // Handles every deadline at or before `now`. Returns whether anything changed.
  function onDeadline(room, now) {
    let changed = false;
    if (room.hostOfflineAt != null && now >= room.hostOfflineAt + hostGraceMs) {
      const next = hostCandidate(room);
      if (next) {
        setHost(room, next.id, now);
        changed = true;
      }
    }
    if (!room.game && room.countdownEndsAt != null && now >= room.countdownEndsAt) {
      startGame(room, now);
      changed = true;
    }
    if (room.game && G) {
      const due = G.nextDeadline(room.game);
      if (due != null && due <= now) {
        G.onDeadline(room.game, now);
        changed = true;
      }
    }
    return changed;
  }

  const isOnlineIn = (room) => (playerId) => online(findPlayer(room, playerId));

  // The `room` part of a Snapshot for one viewer (docs/PROTOCOL.md).
  function roomView(room, viewerId) {
    const isHost = room.hostId === viewerId;
    const n = seatedPlayers(room).length;
    const d = room.deck;
    // Auto mode below the minimum shows a placeholder deck; its hard-rule problems would only confuse.
    const errors = room.settings.roleMode === 'auto' && n < minPlayers ? [] : R.validateDeck(d.roles, n);
    return {
      code: room.code,
      you: viewerId,
      hostId: room.hostId,
      isHost,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.sockets > 0,
        left: p.left,
        ready: p.ready,
        isHost: p.id === room.hostId,
        inGame: !!(room.game && G && G.inGame(room.game, p.id)),
      })),
      settings: room.settings,
      deck: { roles: d.roles, score: d.score, band: d.band, target: d.target, inRange: d.inRange, suggestions: d.suggestions, errors },
      start: startStatus(room),
      countdownEndsAt: room.game ? null : room.countdownEndsAt,
      reclaims: isHost ? room.reclaims.map((r) => ({ requestId: r.requestId, name: r.name })) : [],
    };
  }

  // Deletes rooms nobody has been connected to for cleanupMs, and any room after 12 hours.
  // Returns the deleted rooms with the reason, so server.js can tell any connected sockets.
  function sweep(now) {
    const removed = [];
    for (const room of [...rooms.values()]) {
      const nobody = !room.players.some((p) => p.sockets > 0);
      const empty = nobody && now - (room.emptySince ?? room.lastActiveAt) >= cleanupMs;
      const expired = now - room.createdAt >= ROOM_LIFETIME_MS;
      if (empty || expired || !room.players.length) {
        rooms.delete(room.code);
        removed.push({ room, reason: expired ? 'This room has expired' : 'This room was closed' });
      }
    }
    return removed;
  }

  // The persistent part of a room for the store: no socket counts, socket ids, timers, pending
  // reclaims or lobby countdown. Seat tokens are only ever stored hashed.
  function serializeRoom(room, now) {
    return {
      v: SNAPSHOT_VERSION,
      savedAt: now,
      room: {
        code: room.code,
        hostId: room.hostId,
        players: room.players.map((p) => ({ id: p.id, name: p.name, tokenHash: p.tokenHash, ready: p.ready, left: p.left, joinedAt: p.joinedAt })),
        settings: room.settings,
        deck: room.deck,
        deckPlayers: room.deckPlayers,
        game: room.game,
        createdAt: room.createdAt,
      },
    };
  }

  // Rebuilds a saved room after a restart: everyone offline, ready flags cleared, every game
  // deadline moved by the downtime. Returns the room (now in the store) or null if unusable.
  function restoreRoom(data, now) {
    const r = data && data.v === SNAPSHOT_VERSION && isObject(data.room) ? data.room : null;
    if (!r || typeof r.code !== 'string' || !CODE_RE.test(r.code) || !Array.isArray(r.players) || !r.players.length) return null;
    if (rooms.has(r.code)) return rooms.get(r.code);
    const room = {
      code: r.code,
      hostId: r.hostId,
      players: r.players.map((p) => ({
        id: String(p.id), name: String(p.name), tokenHash: String(p.tokenHash),
        ready: false, sockets: 0, left: !!p.left, joinedAt: Number(p.joinedAt) || now,
      })),
      settings: { ...defaultSettings(), ...(isObject(r.settings) ? r.settings : {}) },
      deck: isObject(r.deck) ? r.deck : null,
      deckPlayers: Number(r.deckPlayers) || 0,
      game: isObject(r.game) ? r.game : null,
      countdownEndsAt: null,
      reclaims: [],
      createdAt: Number(r.createdAt) || now,
      lastActiveAt: now,
      emptySince: now,
      hostOfflineAt: now,
    };
    if (room.game && !G) return null;
    if (room.game) G.shiftDeadlines(room.game, now - (Number(data.savedAt) || now));
    if (!room.players.some((p) => p.id === room.hostId)) room.hostId = (seatedPlayers(room)[0] || room.players[0]).id;
    if (!room.deck) deal(room);
    rooms.set(room.code, room);
    return room;
  }

  return {
    rooms, minPlayers, timeScale, countdownMs, hostGraceMs,
    getRoom, findPlayer, seatedPlayers, isOnlineIn, startStatus,
    create, join, checkSeat, connect, disconnect,
    requestReclaim, cancelReclaims, approveReclaim,
    leave, kick, transferHost, setReady, updateSettings, shuffle, endGame, playAgain,
    nextDeadline, onDeadline, roomView, sweep, serializeRoom, restoreRoom,
  };
}

module.exports = {
  G, RoomError, createRooms, defaultSettings, mergeSettings, validateSetting, cleanName, normalizeCode, hashToken,
  SNAPSHOT_VERSION, CODE_ALPHABET, CODE_RE, COUNTDOWN_MS, HOST_GRACE_MS, CLEANUP_MS, ROOM_LIFETIME_MS, MAX_ROOMS,
};
