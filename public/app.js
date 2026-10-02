// Werewolf phone client: plain ES2020 module, no framework, no build step.
// The server is the moderator. This file draws the latest personalised snapshot
// (docs/PROTOCOL.md) and turns taps into acknowledged socket events.
// Rendering is a pure function of (snapshot, local UI state) that is morphed into
// the DOM, so held buttons, focus and scroll survive every new snapshot.
// `?mock=<name>` renders a sample snapshot from public/mock/ with no server.

/* ---------- Utilities ---------- */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ESC[ch]);

class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Safe(String(s));
const fmt = (v) => {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(fmt).join('');
  return esc(v);
};
// Every interpolated value is HTML-escaped unless it was built by html`` or raw().
function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += fmt(vals[i]) + strings[i + 1];
  return new Safe(out);
}

const ico = (id, cls = '') => html`<svg class="ico ${cls}" aria-hidden="true" focusable="false"><use href="#${id}"></use></svg>`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listJoin = (items) => {
  const a = items.filter(Boolean);
  if (a.length <= 1) return a.join('');
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
};
const initials = (name) => {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  const chars = parts.length > 1 ? [parts[0], parts[parts.length - 1]].map((p) => Array.from(p)[0]) : Array.from(parts[0] || '?').slice(0, 2);
  return chars.join('').toUpperCase();
};
const hueOf = (text) => {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  // Skip the red band so an avatar never reads as "wolf".
  const hues = [190, 215, 240, 265, 290, 35, 50, 95, 140, 165];
  return hues[h % hues.length];
};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const titleCase = (s) => String(s).replace(/(^|\s)\S/g, (c) => c.toUpperCase());

/* ---------- Storage (every access may throw in private mode) ---------- */

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } },
};
const SEAT_KEY = 'ww.seat';
const NAME_KEY = 'ww.name';
const PREFS_KEY = 'ww.prefs';

const params = new URLSearchParams(location.search);
const MOCK = params.get('mock');

function savedSeat() {
  if (MOCK) return mockSeat;
  const s = store.get(SEAT_KEY, null);
  return s && s.code && s.playerId && s.token ? s : null;
}
// After leaving a game the seat stays saved, flagged `left`, and is not sent in the handshake
// (PROTOCOL: Leaving and rejoining). Home then offers "Rejoin <CODE> as <name>".
const handshakeSeat = () => { const s = savedSeat(); return s && !s.left ? { code: s.code, playerId: s.playerId, token: s.token } : null; };
let mockSeat = null;
function saveSeat(seat) {
  const s = { code: seat.code, playerId: seat.playerId, token: seat.token, name: seat.name || ui.home.name, left: !!seat.left };
  if (MOCK) mockSeat = s; else store.set(SEAT_KEY, s);
}
function forgetSeat() { if (MOCK) mockSeat = null; else store.del(SEAT_KEY); }

const prefs = Object.assign({ narration: false, sounds: false, haptics: true }, store.get(PREFS_KEY, {}));
const savePrefs = () => store.set(PREFS_KEY, prefs);

/* ---------- State ---------- */

const state = {
  snap: null,          // latest Snapshot from the server
  offset: 0,           // serverNow minus local clock, for countdowns
  roles: {},           // RoleInfo by id
  conn: MOCK ? 'mock' : 'idle',   // idle, connecting, online, offline, mock
  everOnline: false,
  away: false,         // left a game in progress; home screen offers Rejoin
};

const ui = {
  home: { name: store.get(NAME_KEY, ''), code: '', errors: {}, busy: false },
  notice: null,        // { title, text } shown on Home (kicked, shutdown, seat ended)
  reclaim: null,       // { stage: 'offer' | 'waiting', code, name, requestId }
  sheet: null,         // 'code' | 'roles' | 'menu' | 'guide' | 'transfer' | 'player:<id>'
  dialog: null,        // { title, text, yes, no, tone, run }
  hold: {},            // press-and-hold reveals currently held: card, eye, myrole, secret, news
  sticky: {},          // the same reveals toggled on by a double-tap or a screen reader
  pick: [],            // current tile selection for the task on screen
  pickKey: '',
  witch: { heal: null, poison: null },   // the Witch's choice in the private panel
  cupid: [],                             // Cupid's pair in the private panel
  peekOpen: false,                       // Peek toggled open (auto-hides)
  privNote: '',                          // status line inside the private panel
  pendingVote: null,
  death: null,         // cause shown by the full-screen death moment
  busy: {},            // in-flight actions, to disable double taps
  expanded: {},        // lobby disclosure state
  screenKey: '',
};

const ROLE_ORDER = ['villager', 'seer', 'apprentice', 'doctor', 'witch', 'hunter', 'cupid', 'elder', 'prince',
  'mason', 'lycan', 'werewolf', 'shadowwolf', 'wolfcub', 'minion', 'sorceress', 'jester'];
const ALWAYS_ALLOWED = ['werewolf', 'villager'];
const TEAM_NAME = { village: 'Village', wolves: 'Werewolves', solo: 'On their own' };
const WIN_TEXT = {
  village: 'The village wins when every killer wolf is dead.',
  wolves: 'The wolves win when they equal or outnumber everyone else alive.',
  solo: 'You win alone if the village votes you out.',
};

function setRoles(list) {
  state.roles = {};
  for (const r of list || []) state.roles[r.id] = r;
}
const roleInfo = (id) => state.roles[id] || { id, name: titleCase(String(id || 'Unknown')), team: 'village', summary: '', rules: '', acts: '' };
const roleName = (id) => roleInfo(id).name;
const roleSigil = (id, cls = '') => ico(`r-${ROLE_ORDER.includes(id) ? id : 'villager'}`, cls);

async function loadRoles() {
  const urls = MOCK ? ['mock/roles.json'] : ['/api/roles', 'mock/roles.json'];
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) continue;
      const body = await res.json();
      if (Array.isArray(body.roles) && body.roles.length) { setRoles(body.roles); return; }
    } catch { /* try the bundled copy next */ }
  }
}

/* ---------- Clock ---------- */

const serverNow = () => Date.now() + state.offset;
function msLeft(deadline, paused) {
  if (!deadline) return null;
  if ((paused || deadline.endsAt == null) && deadline.remainingMs != null) return Math.max(0, deadline.remainingMs);
  if (deadline.endsAt == null) return null;
  return Math.max(0, deadline.endsAt - serverNow());
}
function clockText(ms) {
  if (ms == null) return '';
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/* ---------- DOM morph: patch the live tree to match freshly rendered HTML ---------- */

const keyOf = (n) => (n.nodeType === 1 ? n.getAttribute('data-key') || (n.id ? `#${n.id}` : null) : null);
const sameKind = (a, b) => a.nodeType === b.nodeType && (a.nodeType !== 1 || a.tagName === b.tagName);

function morph(target, markup) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(markup);
  morphChildren(target, tpl.content);
}

function morphChildren(from, to) {
  const keyed = new Map();
  for (const n of from.childNodes) { const k = keyOf(n); if (k) keyed.set(k, n); }
  const wanted = Array.from(to.childNodes);
  let i = 0;
  for (const next of wanted) {
    const cur = from.childNodes[i] || null;
    const k = keyOf(next);
    let match = null;
    if (k) {
      const found = keyed.get(k);
      if (found && sameKind(found, next)) { match = found; keyed.delete(k); }
    } else if (cur && !keyOf(cur) && sameKind(cur, next)) {
      match = cur;
    }
    if (match) {
      if (match !== cur) from.insertBefore(match, cur);
      patchNode(match, next);
    } else {
      from.insertBefore(next, cur);
    }
    i++;
  }
  while (from.childNodes.length > i) from.removeChild(from.lastChild);
}

function patchNode(a, b) {
  if (a.nodeType !== 1) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  for (const { name, value } of Array.from(b.attributes)) {
    if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  }
  for (const { name } of Array.from(a.attributes)) {
    if (!b.hasAttribute(name)) a.removeAttribute(name);
  }
  const tag = a.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    const v = b.getAttribute('value') ?? '';
    if (a !== document.activeElement && a.value !== v) a.value = v;
    if (a.type === 'checkbox' || a.type === 'radio') a.checked = b.hasAttribute('checked');
    return;
  }
  if (a.hasAttribute('data-morph-skip')) return;
  morphChildren(a, b);
  if (tag === 'SELECT') {
    const sel = b.querySelector('option[selected]');
    if (sel && a.value !== sel.value) a.value = sel.value;
  }
}

/* ---------- Toasts and the screen-reader announcer ---------- */

function toast(text, icon = 'i-info') {
  const box = document.getElementById('toasts');
  if (!box || !text) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('data-testid', 'toast');
  el.innerHTML = String(html`${ico(icon)}<span>${text}</span>`);
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { el.dataset.leaving = 'true'; setTimeout(() => el.remove(), 220); }, 3800);
}

let lastAnnounce = '';
function announce(text) {
  const el = document.getElementById('announcer');
  if (!el || !text || text === lastAnnounce) return;
  lastAnnounce = text;
  el.textContent = '';
  setTimeout(() => { el.textContent = text; }, 60);
}

/* ---------- Haptics, sound and narration (identical for every role) ---------- */

function buzz() {
  if (!prefs.haptics || !navigator.vibrate) return;
  try { navigator.vibrate(35); } catch { /* unsupported */ }
}

let audio = null;
function chime(kind = 'tap') {
  if (!prefs.sounds) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const notes = kind === 'night' ? [392, 294] : kind === 'day' ? [440, 587] : [660];
    notes.forEach((freq, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      const t = audio.currentTime + i * 0.16;
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + 0.3);
    });
  } catch { /* audio unavailable */ }
}

// Narration names phases and deaths only, never roles or actions.
function narrate(text) {
  if (!prefs.narration || !('speechSynthesis' in window) || !text) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    u.pitch = 0.95;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch { /* speech unavailable */ }
}

/* ---------- Screen wake lock ---------- */

let wakeLock = null;
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { wakeLock = null; }
}

/* ---------- Socket ---------- */

let socket = null;
let offlineTimer = null;

function loadSocketScript() {
  return new Promise((resolve) => {
    if (typeof window.io === 'function') { resolve(true); return; }
    const s = document.createElement('script');
    s.src = '/socket.io/socket.io.js';
    s.onload = () => resolve(typeof window.io === 'function');
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

async function connect() {
  const ok = await loadSocketScript();
  if (!ok || typeof window.io !== 'function') {
    state.conn = 'offline';
    render();
    setTimeout(connect, 4000);
    return;
  }
  state.conn = 'connecting';
  socket = window.io({ auth: (cb) => cb(handshakeSeat() || {}) });
  socket.on('connect', () => {
    clearTimeout(offlineTimer);
    stopReconnect();
    state.restarting = false;
    state.conn = 'online';
    state.everOnline = true;
    render();
  });
  socket.on('disconnect', (reason) => {
    // Wait a moment before showing the banner, so a deliberate reconnect does not flash it.
    clearTimeout(offlineTimer);
    offlineTimer = setTimeout(() => { state.conn = 'offline'; render(); }, state.restarting ? 0 : 1200);
    // After a server-side disconnect Socket.IO does not retry by itself.
    if (reason === 'io server disconnect' && !reconnectTimer) scheduleReconnect(1000);
  });
  socket.on('server:restarting', (msg) => {
    state.restarting = true;
    state.conn = 'offline';
    reconnectDelay = 1000;
    scheduleReconnect(Math.max(0, Number(msg?.reconnectInMs) || 1000));
    render();
  });
  socket.on('connect_error', () => {
    clearTimeout(offlineTimer);
    offlineTimer = setTimeout(() => { state.conn = 'offline'; render(); }, 1200);
  });
  socket.on('state', onState);
  socket.on('seat:invalid', () => {
    const old = savedSeat();
    forgetSeat();
    state.snap = null;
    state.away = false;
    ui.resuming = false;
    ui.notice = { title: 'Your saved seat has expired', text: `Your seat${old?.code ? ` in ${old.code}` : ''} isn’t valid any more: the room closed, or the seat moved to another phone. Create a room or join one with its code.` };
    render();
  });
  socket.on('kicked', (msg) => {
    forgetSeat();
    state.snap = null;
    state.away = false;
    ui.resuming = false;
    ui.sheet = null;
    ui.dialog = null;
    ui.notice = { title: 'You were removed from the room', text: msg?.reason || 'The host removed you. You can join again with the room code.' };
    render();
  });
  socket.on('reclaim:result', onReclaimResult);
  socket.on('server:shutdown', (msg) => {
    forgetSeat();
    state.snap = null;
    state.away = false;
    ui.resuming = false;
    ui.sheet = null;
    ui.dialog = null;
    ui.notice = { title: 'The server is restarting', text: msg?.message || 'This game has ended. Create a new room in a minute.' };
    render();
  });
}

let reconnectTimer = null;
let reconnectDelay = 1000;
function stopReconnect() { clearTimeout(reconnectTimer); reconnectTimer = null; reconnectDelay = 1000; }
function scheduleReconnect(delay) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!socket || socket.connected) return;
    socket.connect();
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    scheduleReconnect(reconnectDelay);
  }, delay);
}

// The server answers RETRY while it is busy restoring or handing over a room: wait about 2 s and try again.
async function emitRetry(event, payload) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await emit(event, payload);
    if (res.code !== 'RETRY') {
      if (ui.retrying) { ui.retrying = false; render(); }
      return res;
    }
    if (!ui.retrying) toast('The server is updating. Trying again in a moment…', 'i-clock');
    ui.retrying = true;
    render();
    await sleep(2000);
  }
  ui.retrying = false;
  return { ok: false, code: 'RETRY', error: 'The server is still updating. Try again in a minute.' };
}

function emit(event, payload = {}) {
  return new Promise((resolve) => {
    if (MOCK) { resolve(mockEmit(event, payload)); return; }
    if (!socket || !socket.connected) {
      resolve({ ok: false, code: 'OFFLINE', error: 'Not connected to the game server. Wait for it to reconnect and try again.' });
      return;
    }
    socket.timeout(8000).emit(event, payload, (err, res) => {
      if (err) resolve({ ok: false, code: 'TIMEOUT', error: 'The server did not answer. Check your connection and try again.' });
      else resolve(res && typeof res === 'object' ? res : { ok: false, code: 'BAD_RESPONSE', error: 'The server sent an unexpected answer.' });
    });
  });
}

// Sends an event, shows its error, and returns the acknowledgement.
async function send(event, payload, { quiet = false, key = event } = {}) {
  if (ui.busy[key]) return { ok: false, code: 'BUSY' };
  ui.busy[key] = true;
  render();
  const res = await emit(event, payload);
  ui.busy[key] = false;
  if (!res.ok && !quiet) showError(res);
  render();
  return res;
}

function showError(res) {
  if (res.code === 'BUSY') return;
  if (res.code === 'RATE_LIMITED') { toast('Too many taps at once. Wait a second and try again.', 'i-clock'); return; }
  toast(res.error || 'That did not work. Try again.', 'i-alert');
}

function onReclaimResult(res) {
  if (res && res.ok) {
    saveSeat({ code: res.code, playerId: res.playerId, token: res.token, name: ui.reclaim?.name });
    ui.reclaim = null;
    ui.notice = null;
    toast('The host gave you your seat back.', 'i-check');
    emitRetry('room:resume', { code: res.code, playerId: res.playerId, token: res.token }).then((r) => {
      if (!r.ok) showError(r);
    });
  } else {
    ui.reclaim = null;
    ui.notice = { title: 'The host said no', text: res?.reason || 'Your seat stays where it is. Check your name or ask the host.' };
  }
  render();
}

/* ---------- Snapshots ---------- */

function onState(snap) {
  if (!snap || !snap.room) return;
  const prev = state.snap;
  state.snap = snap;
  if (typeof snap.serverNow === 'number') state.offset = snap.serverNow - Date.now();
  ui.notice = null;
  ui.reclaim = null;
  ui.resuming = false;
  // "Confirmed tonight" only lasts for the current night (a new game reuses round numbers).
  if (snap.game?.phase !== 'night') { if (MOCK) mockNightDone = ''; else store.del(NIGHT_KEY); }
  if (snap.room.code) {
    const seat = savedSeat();
    if (seat && seat.code !== snap.room.code) saveSeat({ ...seat, code: snap.room.code });
  }
  if (!state.away) noticeChanges(prev, snap);
  render();
}

const gamePlayer = (g, id) => g?.players?.find((p) => p.id === id) || null;
const nameOf = (id) => {
  const s = state.snap;
  return gamePlayer(s?.game, id)?.name || s?.room?.players?.find((p) => p.id === id)?.name || (id === 'skip' ? 'Skip' : String(id ?? ''));
};

// Phase changes drive narration, haptics, the death moment and screen-reader announcements.
let deathTimer = null;
function noticeChanges(prev, next) {
  const a = prev?.game;
  const b = next.game;
  if (!b) {
    if (a) announce('Back in the lobby.');
    return;
  }
  const phaseChanged = !a || a.phase !== b.phase || a.round !== b.round;
  const stageChanged = phaseChanged || a?.day?.stage !== b.day?.stage;
  if (phaseChanged && b.phase === 'reveal') announce('The roles are dealt. Press and hold the card to see yours.');
  if (phaseChanged && b.phase === 'night') {
    buzz();
    chime('night');
    narrate(`Night ${b.round} falls over the village.`);
    // Never speak the task itself: a screen reader on speaker would give the role away.
    announce(`Night ${b.round}. Pick a player, then confirm.`);
  }
  if (b.phase === 'day' && stageChanged && a) {
    const stage = b.day?.stage;
    if (a.phase === 'night') {
      const dead = (b.day?.announcements || []).filter((x) => x.kind === 'death' && x.playerId).map((x) => nameOf(x.playerId));
      chime('day');
      narrate(dead.length ? `Dawn breaks. ${listJoin(dead)} ${dead.length === 1 ? 'was' : 'were'} found dead.` : 'Dawn breaks. Nobody died in the night.');
      announce(dead.length ? `Day ${b.round}. ${listJoin(dead)} died in the night.` : `Day ${b.round}. Nobody died in the night.`);
    } else if (stage === 'vote') {
      narrate('Time to vote.');
      announce('Voting is open.');
    } else if (stage === 'verdict' && b.day?.verdict) {
      const v = b.day.verdict;
      narrate(v.outcome === 'eliminated' && v.eliminated ? `${nameOf(v.eliminated)} leaves the village.` : 'Nobody leaves the village.');
      announce(v.text);
    }
  }
  if (a && b.phase === 'day' && !stageChanged) {
    // Deaths during the day outside the verdict, such as the Hunter's shot.
    const fresh = b.players.filter((p) => !p.alive && gamePlayer(a, p.id)?.alive).map((p) => p.name);
    if (fresh.length) { narrate(`${listJoin(fresh)} ${fresh.length === 1 ? 'has' : 'have'} died.`); announce(`${listJoin(fresh)} died.`); }
  }
  if (phaseChanged && b.phase === 'over' && b.winner) {
    narrate(`The game is over. ${b.winner.title}.`);
    announce(`Game over. ${b.winner.title}. ${b.winner.text || ''}`);
  }
  // The full-screen death moment, skipped for a Hunter who has 30 seconds to shoot.
  const shooting = b.day?.stage === 'shot' && b.day?.shooter === next.room.you;
  if (a?.me?.alive && b.me && !b.me.alive && !shooting) {
    ui.death = gamePlayer(b, next.room.you)?.cause || 'night';
    buzz();
    clearTimeout(deathTimer);
    deathTimer = setTimeout(() => { if (ui.death) { ui.death = null; render(); } }, 6000);
  }
}

/* ---------- Render core ---------- */

const THEME_COLOR = { dusk: '#0C1719', night: '#070D0E', day: '#F8D9B4' };
let booted = false;

function pickTheme() {
  const g = state.snap?.game;
  if (MOCK === 'list' || state.away || !g) return 'dusk';
  if (g.phase === 'night') return 'night';
  if (g.phase === 'day' || g.phase === 'over') return 'day';
  return 'dusk';
}

function screenKeyOf() {
  const s = state.snap;
  const g = s?.game;
  if (MOCK === 'list') return 'mocks';
  if (!s && ui.resuming) return 'resuming';
  if (!s || state.away) return ui.reclaim?.stage === 'waiting' ? 'reclaim' : 'home';
  if (!g) return 'lobby';
  if (!g.me) return `late:${g.phase}`;
  if (g.phase === 'day') return `day:${g.round}:${g.day?.stage}`;
  return `${g.phase}:${g.round}`;
}

function taskKey() {
  const g = state.snap?.game;
  if (!g) return '';
  if (g.phase === 'night') {
    const t = g.night?.task;
    return `n:${g.round}:${g.me?.alive}:${t?.kind}`;
  }
  return g.phase === 'day' ? `d:${g.round}:${g.day?.stage}` : g.phase;
}

// Reset the local selection whenever the task on screen changes, seeded from what was sent.
function syncPick() {
  const k = taskKey();
  if (k === ui.pickKey) return;
  ui.pickKey = k;
  ui.pick = [];
  ui.witch = { heal: null, poison: null };
  ui.cupid = [];
  ui.pendingVote = null;
  const g = state.snap?.game;
  const t = g?.night?.task;
  const sub = t?.submitted;
  if (sub && typeof sub === 'object') {
    if (sub.target && LIVE_KINDS.includes(t.kind)) ui.pick = [sub.target];
    if (Array.isArray(sub.targets)) ui.cupid = sub.targets.slice(0, 2);
    if (t.kind === 'witch') ui.witch = { heal: sub.heal ?? null, poison: sub.poison ?? null };
  }
  if (g?.phase === 'night' && g.me && !g.me.alive && g.ghost?.guess) ui.pick = [g.ghost.guess];
}

let renderedOnce = false;
function veil(fromTheme) {
  if (!THEME_COLOR[fromTheme] || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const v = document.createElement('div');
  v.className = 'veil';
  v.setAttribute('aria-hidden', 'true');
  v.style.background = THEME_COLOR[fromTheme];
  document.body.appendChild(v);
  setTimeout(() => v.remove(), 900);
}

function render() {
  if (!booted) return;
  const theme = pickTheme();
  const root = document.documentElement;
  if (root.dataset.theme !== theme) {
    if (renderedOnce) veil(root.dataset.theme);
    root.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
  }
  const key = screenKeyOf();
  const changed = key !== ui.screenKey;
  if (changed) {
    ui.screenKey = key;
    ui.hold = {};
    ui.sticky = {};
    ui.peekOpen = false;
    ui.privNote = '';
    clearTimeout(peekTimer);
    if (ui.sheet !== 'menu') ui.sheet = null;
    if (ui.dialog && !ui.dialog.keep) ui.dialog = null;
  }
  syncPick();
  const renderedBefore = renderedOnce;
  morph(document.getElementById('app'), viewApp(key));
  renderedOnce = true;
  if (changed) {
    window.scrollTo(0, 0);
    // Move focus to the new screen's heading for screen readers, but not on first load.
    if (renderedBefore && (!document.activeElement || document.activeElement === document.body)) {
      // In a game, focus lands on the phase title ("Night 2"), never on anything role-specific.
      (document.querySelector('.phase-title') || document.querySelector('#main h1, #main h2'))?.focus({ preventScroll: true });
    }
  }
  tick();
}

// While a sheet, dialog or full-screen moment is up, the screen behind it is inert.
let modalNow = false;
function viewApp(key) {
  const sheet = viewSheet();
  const dialog = viewDialog();
  const overlay = viewOverlay();
  modalNow = !!(String(sheet) || String(dialog) || String(overlay));
  return html`${showBanner() ? viewBanner() : ''}${viewScreen(key)}${viewPrivatePanel()}${sheet}${dialog}${overlay}${viewPeekCard()}`;
}

function viewScreen(key) {
  if (MOCK === 'list') return viewMockList();
  const s = state.snap;
  if (!s && ui.resuming) return viewResuming();
  if (!s || state.away) return ui.reclaim?.stage === 'waiting' ? viewReclaimWait() : viewHome();
  const g = s.game;
  if (!g) return viewLobby();
  if (!g.me) return viewLate();
  if (g.phase === 'reveal') return viewReveal();
  if (g.phase === 'night') return viewNight();
  if (g.phase === 'day') return viewDay();
  return viewOver();
}

const screen = (key, name, body) => html`<div class="screen screen-enter" data-key="screen:${key}" data-screen="${name}" data-testid="screen-${name}" ${modalNow ? raw('inert') : ''}><a class="skip-link" href="#main">Skip to content</a>${body}</div>`;
const actionbar = (inner, note = '') => html`<div class="actionbar" data-testid="actionbar"><div class="actionbar-inner">${inner}${note ? html`<p class="actionbar-note" data-testid="actionbar-note">${note}</p>` : ''}</div></div>`;
const isOpen = (kind) => !!(ui.hold[kind] || ui.sticky[kind]);
const peeking = () => !!(ui.hold.eye || ui.peekOpen);

function showBanner() {
  if (MOCK) return !!ui.forceBanner;
  if (state.conn === 'online') return false;
  return !!(state.snap || handshakeSeat()) && (state.everOnline || state.conn === 'offline' || state.restarting);
}

const viewBanner = () => html`<div class="banner" data-key="banner" role="status" data-testid="reconnect-banner">${ico(state.restarting ? 'i-refresh' : 'i-wifi-off', 'ico-sm')}<span>${state.restarting ? 'Updating the server… reconnecting' : 'Reconnecting to the game'}</span><span class="banner-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>`;

/* ---------- Header, timer and tiles ---------- */

function phaseTitle(g) {
  if (g.phase === 'reveal') return 'Your role';
  if (g.phase === 'night') return `Night ${g.round}`;
  if (g.phase === 'over') return 'Game over';
  const st = g.day?.stage;
  if (st === 'vote') return 'Vote';
  if (st === 'verdict') return 'Verdict';
  return `Day ${g.round}`;
}
function phaseSub(g) {
  if (g.phase === 'reveal') return 'Read your card';
  if (g.phase === 'night') return 'Act in secret';
  if (g.phase === 'over') return 'All roles shown';
  const st = g.day?.stage;
  if (st === 'vote' || st === 'verdict') return `Day ${g.round}`;
  return st === 'shot' ? 'The Hunter aims' : 'Talk it out';
}

function viewTimer(g, testid = 'timer') {
  const d = g?.deadline;
  const ms = msLeft(d, g?.paused);
  if (ms == null) return html`<div class="timer" data-testid="${testid}" aria-hidden="true"></div>`;
  const paused = !!g.paused;
  return html`<div class="timer" role="timer" data-timer data-testid="${testid}" data-ends="${d.endsAt ?? ''}" data-remaining="${d.remainingMs ?? ''}" data-paused="${paused}" data-low="${!paused && ms <= 10000}" aria-label="${d.label || 'Time left'}">
    <span class="timer-val num">${paused ? 'Paused' : clockText(ms)}</span><span class="timer-label">${paused ? `${clockText(ms)} left` : d.label || ''}</span></div>`;
}

// Updates every countdown on screen four times a second without a full render.
function tick() {
  for (const el of document.querySelectorAll('[data-timer]')) {
    const paused = el.dataset.paused === 'true';
    const ms = paused ? Number(el.dataset.remaining || 0) : Math.max(0, Number(el.dataset.ends || 0) - serverNow());
    const val = el.querySelector('.timer-val');
    const text = paused ? 'Paused' : clockText(ms);
    if (val && val.textContent !== text) val.textContent = text;
    const low = String(!paused && ms <= 10000);
    if (el.dataset.low !== low) el.dataset.low = low;
  }
  const cd = document.querySelector('[data-countdown]');
  if (cd) {
    const n = String(Math.max(1, Math.ceil((Number(cd.dataset.countdown) - serverNow()) / 1000)));
    if (cd.textContent !== n) cd.textContent = n;
  }
}

function viewTopbar() {
  const s = state.snap;
  const g = s.game;
  const me = g.me;
  const icon = { night: 'i-moon', day: 'i-sun', over: 'i-flag' }[g.phase] || 'i-cards';
  return html`<header class="topbar" data-testid="topbar"><div class="topbar-inner">
    <div class="topbar-row">
      <button type="button" class="code-chip" data-act="sheet" data-arg="code" data-testid="code-chip" translate="no" aria-label="Room code ${s.room.code}. Show the code and QR code">${s.room.code}${ico('i-qr')}</button>
      <div class="phase">${ico(icon)}<div class="phase-text"><h1 class="phase-title" tabindex="-1" data-testid="phase-title">${phaseTitle(g)}</h1><span class="phase-sub">${phaseSub(g)}</span></div></div>
      ${viewTimer(g)}
    </div>
    <div class="tools${me ? '' : ' tools-2'}">
      ${me ? html`<button type="button" class="tool" data-hold="myrole" data-testid="my-role-btn" aria-pressed="${isOpen('myrole')}" aria-label="My role. Press and hold to see it">${ico('i-id')}<span>My role</span></button>` : ''}
      <button type="button" class="tool" data-act="sheet" data-arg="roles" data-testid="roles-btn" aria-label="Roles in this game">${ico('i-cards')}<span>Roles</span></button>
      ${me ? html`<button type="button" class="tool" data-hold="eye" data-testid="eye-btn" data-holding="${peeking()}" aria-pressed="${peeking()}" aria-label="Peek. Tap to show your private marks${g.phase === 'night' ? ' and panel' : ''}; it hides itself">${ico(peeking() ? 'i-eye' : 'i-eye-off')}<span>Peek</span></button>` : ''}
      <button type="button" class="icon-btn" data-act="sheet" data-arg="menu" data-testid="menu-btn" aria-label="Menu">${ico('i-menu')}</button>
    </div>
  </div></header>`;
}

const avatar = (name, { dead = false, size = '' } = {}) => html`<span class="avatar ${size}" style="--h:${hueOf(name)}" data-dead="${dead}" aria-hidden="true">${initials(name)}</span>`;
const badge = (text, tone = '', icon = '') => html`<span class="tile-badge" data-tone="${tone}">${icon ? ico(icon) : ''}${text}</span>`;

function revealedText(p) {
  const r = p.revealed;
  if (!r) return '';
  if (r.kind === 'role') return roleName(r.value);
  if (r.kind === 'team') return { village: 'Village team', wolves: 'Wolf team', solo: 'Solo' }[r.value] || '';
  if (r.kind === 'wolf') return r.value ? 'A killer wolf' : 'Not a killer wolf';
  return '';
}

const inList = (list, p) => (list || []).some((x) => x === p.id || x === p.name);
const MARK = { wolf: ['Werewolf', 'wolf', 'r-werewolf'], notwolf: ['Not a wolf', 'good', 'i-check'], seer: ['Seer', 'accent', 'r-seer'], notseer: ['Not Seer', '', 'i-x'] };
const TONE = { village: 'good', wolves: 'wolf', solo: 'solo' };

// A role is shown openly only when everyone may know it; private knowledge waits for the eye.
function roleVisibility(g, p) {
  if (!p.role) return null;
  if (g.phase === 'over') return 'public';
  const k = g.me?.knows || {};
  if (p.id === state.snap.room.you || inList(k.pack, p) || inList(k.masons, p) || inList(k.wolves, p)) return 'private';
  if (g.me && !g.me.alive && state.snap.room.settings?.deadSeeRoles) return 'private';
  if (!p.alive) return p.revealed?.kind === 'role' ? 'public' : 'private';
  return 'public';
}

function peekBadges(g, p) {
  if (!peeking() || !g.me) return [];
  const out = [];
  const k = g.me.knows || {};
  if (roleVisibility(g, p) === 'private') {
    const info = roleInfo(p.role);
    out.push(badge(info.name, TONE[info.team] || '', `r-${p.role}`));
  } else if (inList(k.wolves, p)) {
    out.push(badge('Killer wolf', 'wolf', 'r-werewolf'));
  } else if (inList(k.pack, p)) {
    out.push(badge('Your pack', 'wolf', 'r-werewolf'));
  }
  if (k.lover && k.lover.id === p.id) out.push(badge('Your lover', 'love', 'i-heart'));
  const m = g.me.marks?.[p.id];
  if (m && MARK[m]) out.push(badge(MARK[m][0], MARK[m][1], MARK[m][2]));
  return out;
}

function viewTile(g, p, o = {}) {
  const room = state.snap.room.players.find((x) => x.id === p.id);
  const you = p.id === state.snap.room.you;
  const dead = p.alive === false;
  const flags = [];
  if (room?.isHost) flags.push(html`${ico('i-crown')}<span class="sr-only">Host.</span>`);
  if (room?.left) flags.push(html`${ico('i-door')}<span class="sr-only">Left the game.</span>`);
  else if (room && !room.connected) flags.push(html`${ico('i-wifi-off')}<span class="sr-only">Offline.</span>`);
  const subs = [];
  if (you) subs.push('You');
  if (dead) subs.push(revealedText(p) || 'Dead');
  else if (roleVisibility(g, p) === 'public') subs.push(roleName(p.role));
  const sub = o.sub ?? subs.join(', ');
  const badges = [...(o.badges || []), ...peekBadges(g, p)];
  const inner = html`${o.selected ? html`<span class="tile-check" aria-hidden="true">${ico('i-check')}</span>` : ''}
    ${flags.length ? html`<span class="tile-flags">${flags}</span>` : ''}
    ${avatar(p.name, { dead })}
    <span class="tile-name" translate="no">${p.name}</span>
    ${sub ? html`<span class="tile-sub">${sub}${dead ? html`<span class="sr-only">, dead</span>` : ''}</span>` : dead ? html`<span class="sr-only">Dead</span>` : ''}
    <span class="tile-badges">${badges}</span>`;
  if (o.act) {
    // A living player who is not a legal target looks exactly like one who is, so a glance
    // at someone's phone gives nothing away. Taps on them are ignored; Peek shows why.
    return html`<button type="button" class="tile" data-key="t:${p.id}" data-testid="tile-${p.id}" data-act="${o.act}" data-arg="${p.id}"
      aria-pressed="${!!o.selected}" aria-disabled="${!o.pickable}" data-pickable="${!!o.pickable}" data-dead="${dead}">${inner}</button>`;
  }
  return html`<div class="tile" role="listitem" data-key="t:${p.id}" data-testid="tile-${p.id}" data-dead="${dead}">${inner}</div>`;
}

const staticTiles = (g, players = g.players) => html`<div class="tiles" role="list" aria-label="Players" data-testid="player-grid">${players.map((p) => viewTile(g, p))}</div>`;

/* ---------- Home ---------- */

const SKYLINE = raw(`<svg class="skyline" viewBox="0 0 400 120" preserveAspectRatio="none" aria-hidden="true">
  <path fill="currentColor" d="M0 120V92l14-22 12 20 10-30 14 32 9-16 10 18 16-26 12 22h22V72l22-18 22 18v36h16V84l10-14 10 14v24h20l12-40 14 40 10-24 12 24h18V78l20-16 20 16v30h14l12-30 14 30 10-18 12 18 14-36 14 36h12v12z"/>
</svg>`);

function viewHome() {
  const h = ui.home;
  const seat = savedSeat();
  const rejoin = !!seat;
  const err = h.errors || {};
  const body = html`<main class="main" id="main">
    <header class="home-hero">
      <svg class="home-mark" aria-hidden="true"><use href="#i-mark"></use></svg>
      <h1 class="home-title" tabindex="-1" translate="no">Werewolf</h1>
      <p class="home-lede">A party game for 5 to 20 friends in one room. Everyone plays on their own phone and the app runs the night.</p>
    </header>
    ${ui.notice ? html`<div class="panel notice" role="alert" data-testid="notice">
      <div class="info-line">${ico('i-info')}<div><p class="h3">${ui.notice.title}</p><p class="muted">${ui.notice.text}</p></div></div></div>` : ''}
    ${rejoin ? html`<div class="rejoin" data-testid="rejoin">
      ${avatar(seat.name || '?')}
      <div class="rejoin-text"><p class="rejoin-title" translate="no">Rejoin ${seat.code} as ${seat.name || 'your seat'}</p><p class="small muted">${seat.left ? 'You left the game. You can rejoin until it ends.' : 'Your seat is saved on this phone.'}</p></div>
      <button type="button" class="btn btn-primary btn-sm" data-act="rejoin" data-testid="rejoin-btn" ${ui.busy['room:resume'] ? raw('disabled') : ''}>${ui.busy['room:resume'] ? 'Rejoining…' : 'Rejoin'}</button>
    </div>` : ''}
    <form class="panel home-card" data-form="home" novalidate>
      <div class="field">
        <label class="label" for="name-input">Your name</label>
        <input class="input" type="text" id="name-input" name="name" data-testid="name-input" value="${h.name}" maxlength="16" autocomplete="nickname" autocapitalize="words" spellcheck="false" enterkeyhint="go" placeholder="Your name, like Zoya…" translate="no" aria-invalid="${!!err.name}" ${err.name ? raw('aria-describedby="name-error"') : ''}>
        ${err.name ? html`<p class="error" id="name-error" data-testid="name-error">${ico('i-alert')}${err.name}</p>` : ''}
      </div>
      <button type="submit" class="btn btn-primary btn-block btn-big" data-act="create" data-testid="create-btn" ${h.busy ? raw('disabled') : ''}>${ico('i-plus')}${h.busy === 'create' ? 'Creating a room…' : 'Create a room'}</button>
      <p class="or-rule">or join with a code</p>
      <div class="field">
        <label class="label" for="join-code">Room code</label>
        <div class="join-row">
          <input class="input input-code" type="text" inputmode="text" id="join-code" name="code" data-testid="join-code" translate="no" value="${h.code}" maxlength="4" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="join" aria-invalid="${!!err.code}" ${err.code ? raw('aria-describedby="code-error"') : ''}>
          <button type="submit" class="btn btn-sm" data-act="join" data-testid="join-btn" ${h.busy ? raw('disabled') : ''}>${h.busy === 'join' ? 'Joining…' : 'Join'}</button>
        </div>
        ${err.code ? html`<p class="error" id="code-error" data-testid="code-error">${ico('i-alert')}${err.code}</p>` : ''}
      </div>
    </form>
    <p class="home-foot" data-testid="home-foot">${ui.retrying ? 'The server is updating. Trying again in a moment…' : state.conn === 'offline' && !MOCK ? 'Waiting for the game server…' : 'Friends join by code, link or QR code.'}</p>
  </main>`;
  return screen(ui.screenKey, 'home', body);
}

function viewReclaimWait() {
  const r = ui.reclaim;
  return screen(ui.screenKey, 'reclaim', html`<main class="main" id="main">
    <div class="task-done">
      <span class="task-done-mark">${ico('i-crown')}</span>
      <h1 class="task-done-title" tabindex="-1">Waiting for the host</h1>
      <p class="lede">The host’s phone is asking them to give ${r.name}’s seat in ${r.code} to this phone. Keep this screen open.</p>
    </div>
    <button type="button" class="btn btn-block" data-act="reclaim-cancel" data-testid="reclaim-cancel">Cancel</button>
  </main>`);
}

/* ---------- Lobby ---------- */

const qrSrc = (code) => (MOCK ? 'mock/qr.svg' : `/qr/${encodeURIComponent(code)}.svg`);
const joinLink = (code) => `${location.origin}/?room=${encodeURIComponent(code)}`;
const PRESETS = {
  person: { label: 'In person', patch: { discussionSeconds: 180, voteSeconds: 60, nightSeconds: 90, nightMinSeconds: 20 } },
  call: { label: 'Voice call', patch: { discussionSeconds: 270, voteSeconds: 90, nightSeconds: 135, nightMinSeconds: 20 } },
  long: { label: 'Long', patch: { discussionSeconds: 360, voteSeconds: 120, nightSeconds: 180, nightMinSeconds: 30 } },
};
const TIMERS = [
  { key: 'discussionSeconds', tid: 'discussion', title: 'Discussion', min: 0, max: 600, step: 30, sub: 'At 0 the host starts the vote' },
  { key: 'voteSeconds', tid: 'vote', title: 'Vote', min: 15, max: 180, step: 15 },
  { key: 'nightSeconds', tid: 'night', title: 'Night', min: 30, max: 300, step: 15 },
  { key: 'nightMinSeconds', tid: 'night-min', title: 'Shortest night', min: 0, max: 60, step: 5, sub: 'So a fast night gives nothing away' },
];
const REVEALS = [
  ['role', 'Their role'], ['day', 'Role, day deaths only'], ['team', 'Their team'], ['wolf', 'Werewolf or not'], ['none', 'Nothing'],
];
const secText = (s) => (s === 0 ? 'Host ends it' : clockText(s * 1000));

function viewLobby() {
  const s = state.snap;
  const r = s.room;
  const me = r.players.find((p) => p.id === r.you);
  const active = r.players.filter((p) => !p.left);
  const readyCount = active.filter((p) => p.ready).length;
  const ready = !!me?.ready;
  const body = html`<main class="main" id="main">
    <div class="spread">
      <div class="row"><svg class="ico ico-lg" aria-hidden="true"><use href="#i-mark"></use></svg><h1 class="h3" tabindex="-1">Lobby</h1></div>
      <button type="button" class="icon-btn" data-act="sheet" data-arg="menu" data-testid="menu-btn" aria-label="Menu">${ico('i-menu')}</button>
    </div>
    ${viewCodeHero(r)}
    ${viewStatusLine(r)}
    ${viewPlayers(r)}
    ${r.isHost ? html`<section class="section" aria-labelledby="speaker-title">
      <div class="section-head"><h2 class="section-title" id="speaker-title">Table speaker</h2></div>
      <div class="panel panel-tight">${switchRow('Narrate from this phone', 'Reads phases and deaths aloud for everyone. The iPhone silent switch mutes it.', prefs.narration, 'pref', 'narration', 'lobby-narration-toggle')}</div>
    </section>` : ''}
    ${viewRoleSetup(r)}
    ${viewSettings(r)}
  </main>
  ${actionbar(html`<button type="button" class="btn btn-block btn-big ${ready ? 'btn-toggle' : 'btn-primary'}" data-act="ready" data-testid="ready-toggle" aria-pressed="${ready}" ${ui.busy['lobby:ready'] ? raw('disabled') : ''}>
      ${ready ? html`${ico('i-check')}You’re ready` : 'Ready'}</button>`,
    `${readyCount} of ${active.length} ready${ready ? '. Tap again if you need a minute.' : ''}`)}`;
  return screen(ui.screenKey, 'lobby', body);
}

function viewCodeHero(r) {
  return html`<section class="code-hero" aria-labelledby="code-label">
    <p class="section-note" id="code-label">Room code. Say it out loud, or let friends scan the QR code.</p>
    <div class="code-top">
      <div class="code-letters" data-testid="room-code" translate="no" aria-label="${r.code.split('').join(' ')}">${r.code.split('').map((c) => html`<span class="code-letter" aria-hidden="true">${c}</span>`)}</div>
      <button type="button" class="qr-thumb" data-act="sheet" data-arg="code" data-testid="qr-btn" aria-label="Show a large QR code"><img src="${qrSrc(r.code)}" alt="" width="72" height="72"></button>
    </div>
    <div class="code-actions">
      <button type="button" class="btn btn-sm" data-act="share" data-testid="share-btn">${ico('i-share')}Share link</button>
      <button type="button" class="btn btn-sm" data-act="copy-link" data-testid="copy-link">${ico('i-copy')}Copy link</button>
    </div>
  </section>`;
}

function viewStatusLine(r) {
  const counting = r.countdownEndsAt && r.countdownEndsAt > serverNow();
  const text = counting ? 'Everyone is ready. The game is starting.' : r.start?.ok ? 'Everyone is ready.' : r.start?.reason || 'Waiting for players.';
  return html`<p class="status-line" data-ok="${!!r.start?.ok}" data-testid="status-line" role="status">${ico(r.start?.ok ? 'i-check' : 'i-clock')}<span>${text}</span></p>`;
}

function viewPlayers(r) {
  const host = r.isHost;
  return html`<section class="section" aria-labelledby="players-title">
    <div class="section-head"><h2 class="section-title" id="players-title">Players</h2><span class="section-note num">${r.players.filter((p) => !p.left).length} of 20</span></div>
    <ul class="panel panel-tight players" data-testid="players">
      ${r.players.map((p) => {
        const you = p.id === r.you;
        const status = p.left ? html`<span class="tag tag-quiet">Left</span>`
          : p.ready ? html`<span class="tag tag-ok">${ico('i-check', 'ico-xs')}Ready</span>`
          : html`<span class="tag tag-quiet">Not ready</span>`;
        return html`<li class="player" data-key="p:${p.id}" data-testid="player-${p.id}">
          ${avatar(p.name, { dead: p.left })}
          <div class="player-main">
            <span class="player-name" translate="no">${p.left ? html`<s>${p.name}</s>` : p.name}${you ? html` <span class="muted">(you)</span>` : ''}</span>
            <span class="player-sub">
              ${p.isHost ? html`${ico('i-crown')}Host` : ''}
              ${!p.connected && !p.left ? html`<span class="dot" aria-hidden="true"></span>Offline` : ''}
            </span>
          </div>
          <span class="player-state">${status}</span>
          ${host && !you ? html`<button type="button" class="icon-btn icon-btn-plain" data-act="sheet" data-arg="player:${p.id}" data-testid="player-menu-${p.id}" aria-label="Options for ${p.name}">${ico('i-more')}</button>` : ''}
        </li>`;
      })}
    </ul>
    ${r.players.length > 15 ? html`<p class="rule-note">${ico('i-info')}<span>With more than 15 players, nights and games run long.</span></p>` : ''}
  </section>`;
}

function lineupChips(roles) {
  const ids = ROLE_ORDER.filter((id) => roles?.[id] > 0);
  if (!ids.length) return html`<p class="empty">No roles yet.</p>`;
  return html`<div class="lineup" data-testid="lineup">${ids.map((id) => {
    const info = roleInfo(id);
    return html`<span class="chip" data-team="${info.team}">${roleSigil(id)}${info.name}${roles[id] > 1 ? html`<span class="chip-count">×${roles[id]}</span>` : ''}</span>`;
  })}</div>`;
}

function viewMeter(deck, showTarget) {
  const pos = (n) => ((clamp(n, -10, 10) + 10) / 20) * 100;
  const verdict = { wolves: 'Favours the wolves', balanced: 'Balanced', village: 'Favours the village' }[deck.band] || 'Balanced';
  const [lo, hi] = deck.target || [-1, 3];
  const score = deck.score > 0 ? `+${deck.score}` : String(deck.score);
  return html`<div class="meter" data-testid="balance-meter">
    <div class="spread"><span class="meter-verdict">${verdict}</span><span class="small muted num">Balance ${score}${showTarget ? `, target ${lo > 0 ? '+' : ''}${lo} to ${hi > 0 ? '+' : ''}${hi}` : ''}</span></div>
    <div class="meter-scale" role="img" aria-label="Balance ${score}. ${verdict}.">
      <span class="meter-zone meter-zone-w"></span><span class="meter-zone meter-zone-b"></span><span class="meter-zone meter-zone-v"></span>
      ${showTarget ? html`<span class="meter-target" style="left:${pos(lo - 0.5)}%;right:${100 - pos(hi + 0.5)}%"></span>` : ''}
      <span class="meter-pin" style="left:${pos(deck.score)}%">${score}</span>
    </div>
    <div class="meter-labels" aria-hidden="true"><span>Wolves</span><span>Fair</span><span>Village</span></div>
  </div>`;
}

function viewRoleSetup(r) {
  const st = r.settings || {};
  const deck = r.deck || { roles: {}, score: 0, band: 'balanced', target: [-1, 3], inRange: true, suggestions: [], errors: [] };
  const host = r.isHost;
  const auto = st.roleMode !== 'manual';
  const allowed = new Set([...(st.allowedRoles || ROLE_ORDER), ...ALWAYS_ALLOWED]);
  const tilt = st.balanceTilt || 'balanced';
  const lead = auto ? 'The app deals a balanced line-up from the allowed roles.' : 'The host sets every count by hand.';
  return html`<section class="section" aria-labelledby="roles-title">
    <div class="section-head"><h2 class="section-title" id="roles-title">Roles</h2><span class="section-note">${auto ? 'Auto' : 'Manual'}</span></div>
    <div class="panel stack-lg" data-testid="role-setup">
      ${host ? seg('roleMode', [['auto', 'Auto'], ['manual', 'Manual']], auto ? 'auto' : 'manual', 'role-mode', 'How the line-up is built') : ''}
      <p class="small muted">${lead}</p>
      ${lineupChips(deck.roles)}
      ${viewMeter(deck, auto)}
      ${auto && !deck.inRange && deck.suggestions?.length ? html`<p class="rule-note" data-testid="deck-suggestions">${ico('i-info')}<span>No line-up lands in the target range. Allowing ${listJoin(deck.suggestions.map(roleName))} would help.</span></p>` : ''}
      ${deck.errors?.length ? html`<ul class="stack" data-testid="deck-errors">${deck.errors.map((e) => html`<li class="error">${ico('i-alert')}${e}</li>`)}</ul>` : ''}
      ${host && auto ? html`
        <div class="stack" style="gap:6px"><span class="set-title">Lean the line-up towards</span>${seg('balanceTilt', [['wolves', 'Wolves'], ['balanced', 'Balanced'], ['village', 'Village']], tilt, 'tilt', 'Lean the line-up towards')}</div>
        <button type="button" class="btn btn-sm btn-block" data-act="shuffle" data-testid="shuffle-btn" ${ui.busy['lobby:shuffle'] ? raw('disabled') : ''}>${ico('i-shuffle')}Deal a new line-up</button>
        <div class="stack">
          <button type="button" class="switch-row" data-act="toggle-expand" data-arg="allowed" aria-expanded="${!!ui.expanded.allowed}" data-testid="allowed-toggle">
            <span class="switch-text"><span class="switch-title">Allowed roles</span><span class="switch-sub">${allowed.size} of ${ROLE_ORDER.length} allowed</span></span>${ico('i-chevron')}
          </button>
          ${ui.expanded.allowed ? html`<div class="role-list" data-testid="allowed-roles">${ROLE_ORDER.map((id) => {
            const info = roleInfo(id);
            const locked = ALWAYS_ALLOWED.includes(id);
            const on = allowed.has(id);
            return html`<button type="button" class="switch-row role-row" role="switch" aria-checked="${on}" data-act="allow" data-arg="${id}" data-testid="allow-${id}" ${locked ? raw('disabled') : ''} data-off="${!on}">
              <span class="role-ico" data-team="${info.team}">${roleSigil(id)}</span>
              <span class="role-row-main"><span class="role-row-name">${info.name}</span><span class="role-row-sub">${locked ? 'Always in the game' : info.summary}</span></span>
              <span class="switch" aria-hidden="true"></span>
            </button>`;
          })}</div>` : ''}
        </div>` : ''}
      ${host && !auto ? html`<div class="role-list" data-testid="manual-roles">${ROLE_ORDER.map((id) => {
        const info = roleInfo(id);
        const n = st.roles?.[id] || 0;
        const max = info.max ?? 1;
        return html`<div class="role-row" data-key="mr:${id}" data-off="${n === 0}">
          <span class="role-ico" data-team="${info.team}">${roleSigil(id)}</span>
          <span class="role-row-main"><span class="role-row-name">${info.name}</span><span class="role-row-sub">${info.value > 0 ? '+' : ''}${info.value}${id === 'mason' ? ', in twos or threes' : ''}</span></span>
          <span class="stepper">
            <button type="button" class="icon-btn" data-act="role-count" data-arg="${id}:-1" data-testid="role-minus-${id}" aria-label="One fewer ${info.name}" ${n <= 0 ? raw('disabled') : ''}>${ico('i-minus')}</button>
            <span class="stepper-val" data-testid="role-count-${id}" aria-live="polite">${n}</span>
            <button type="button" class="icon-btn" data-act="role-count" data-arg="${id}:1" data-testid="role-plus-${id}" aria-label="One more ${info.name}" ${n >= max ? raw('disabled') : ''}>${ico('i-plus')}</button>
          </span>
        </div>`;
      })}</div>` : ''}
    </div>
  </section>`;
}

// Segmented radio group. Guests get the same control, read-only.
function seg(setting, options, value, testid, label, disabled = false) {
  return html`<div class="seg" role="radiogroup" aria-label="${label}" data-testid="${testid}" aria-disabled="${disabled}">
    ${options.map(([v, text]) => html`<button type="button" class="seg-opt" role="radio" aria-checked="${v === value}" data-act="setting" data-arg="${setting}:${v}" data-testid="${testid}-${v}" ${disabled ? raw('disabled') : ''}>${text}</button>`)}
  </div>`;
}

function switchRow(title, sub, on, act, arg, testid, disabled = false) {
  return html`<button type="button" class="switch-row" role="switch" aria-checked="${!!on}" data-act="${act}" data-arg="${arg}" data-testid="${testid}" ${disabled ? raw('disabled') : ''}>
    <span class="switch-text"><span class="switch-title">${title}</span>${sub ? html`<span class="switch-sub">${sub}</span>` : ''}</span>
    <span class="switch" aria-hidden="true"></span>
  </button>`;
}

function viewSettings(r) {
  const st = r.settings || {};
  const host = r.isHost;
  const presetOn = Object.entries(PRESETS).find(([, p]) => Object.entries(p.patch).every(([k, v]) => st[k] === v))?.[0] || '';
  const reveal = REVEALS.find(([v]) => v === st.reveal)?.[1] || 'Their role';
  return html`<section class="section" aria-labelledby="settings-title">
    <div class="section-head"><h2 class="section-title" id="settings-title">Settings</h2>${host ? '' : html`<span class="section-note">Set by the host</span>`}</div>
    <div class="panel rows" data-testid="settings">
      <div class="set-row ${host ? 'set-row-stack' : ''}">
        <span class="set-label"><span class="set-title" id="reveal-label">When someone dies, show</span></span>
        ${host ? html`<select class="select" data-change="reveal" data-testid="setting-reveal" aria-labelledby="reveal-label">${REVEALS.map(([v, t]) => html`<option value="${v}" ${st.reveal === v ? raw('selected') : ''}>${t}</option>`)}</select>`
          : html`<span class="set-val">${reveal}</span>`}
      </div>
      ${switchRow('Kill on night 1', 'Off: the pack only meets on the first night', st.firstNightKill !== false, 'setting', `firstNightKill:${st.firstNightKill === false}`, 'setting-first-night-kill', !host)}
      ${switchRow('Ghosts see every role', 'Leave off in person: faces give it away', !!st.deadSeeRoles, 'setting', `deadSeeRoles:${!st.deadSeeRoles}`, 'setting-dead-see-roles', !host)}
      <div class="set-row set-row-stack">
        <span class="set-label"><span class="set-title">Votes</span><span class="set-sub">${st.voteStyle === 'live' ? 'Everyone sees each vote as it is cast' : 'Hidden until voting closes'}</span></span>
        ${seg('voteStyle', [['secret', 'Secret'], ['live', 'Live']], st.voteStyle || 'secret', 'setting-vote-style', 'Vote style', !host)}
      </div>
      <div class="set-row set-row-stack">
        <span class="set-label"><span class="set-title">Timers</span></span>
        ${seg('preset', Object.entries(PRESETS).map(([k, p]) => [k, p.label]), presetOn, 'setting-preset', 'Timer preset', !host)}
      </div>
      ${TIMERS.map((t) => {
        const v = st[t.key] ?? 0;
        const max = t.key === 'nightMinSeconds' ? Math.min(t.max, st.nightSeconds ?? t.max) : t.max;
        return html`<div class="set-row" data-key="tm:${t.key}">
          <span class="set-label"><span class="set-title">${t.title}</span>${t.sub ? html`<span class="set-sub">${t.sub}</span>` : ''}</span>
          ${host ? html`<span class="stepper">
            <button type="button" class="icon-btn" data-act="timer" data-arg="${t.key}:-1" data-testid="setting-${t.tid}-minus" aria-label="Less ${t.title.toLowerCase()} time" ${v <= t.min ? raw('disabled') : ''}>${ico('i-minus')}</button>
            <span class="stepper-val small num" data-testid="setting-${t.tid}" style="min-width:76px;font-size:17px">${secText(v)}</span>
            <button type="button" class="icon-btn" data-act="timer" data-arg="${t.key}:1" data-testid="setting-${t.tid}-plus" aria-label="More ${t.title.toLowerCase()} time" ${v >= max ? raw('disabled') : ''}>${ico('i-plus')}</button>
          </span>` : html`<span class="set-val num" data-testid="setting-${t.tid}">${secText(v)}</span>`}
        </div>`;
      })}
    </div>
  </section>`;
}

/* ---------- Role knowledge ---------- */

function knowsLines(g) {
  const me = g.me;
  const k = me.knows || {};
  const names = (ids) => listJoin((ids || []).filter((id) => id !== state.snap.room.you).map(nameOf));
  const out = [];
  const killer = roleInfo(me.role).killer;
  if (killer) out.push((k.pack || []).filter((id) => id !== state.snap.room.you).length ? `Your pack: ${names(k.pack)}.` : 'You are the only killer wolf.');
  if (k.wolves?.length) out.push(`The killer wolves: ${names(k.wolves)}. They don’t know you.`);
  if (me.role === 'mason') out.push(k.masons?.length ? `The other Masons: ${names(k.masons)}.` : 'You know the other Masons.');
  if (k.lover) {
    out.push(k.lover.sameTeam
      ? `Your lover is ${nameOf(k.lover.id)}. You are on the same team.`
      : `Your lover is ${nameOf(k.lover.id)}. You are on different teams, so you win together only as the last two alive.`);
  }
  return out;
}

function roleFace(g, { compact = false } = {}) {
  const me = g.me;
  const info = roleInfo(me.role);
  const team = me.team || info.team;
  const knows = knowsLines(g);
  const notes = me.notes || [];
  return html`<span class="row" style="gap:12px">
      <span class="card-sigil">${roleSigil(me.role)}</span>
      <span class="stack" style="gap:2px"><span class="card-name">${info.name}</span><span class="card-team">${TEAM_NAME[team]}</span></span>
    </span>
    <span class="card-text">${info.summary || info.rules}</span>
    ${knows.length ? html`<span class="card-block"><span class="card-block-title">What you know</span>${knows.map((t) => html`<span class="card-text">${t}</span>`)}</span>` : ''}
    <span class="card-block"><span class="card-block-title">How you win</span><span class="card-text">${WIN_TEXT[team]}</span></span>
    ${compact ? '' : html`<span class="card-text small muted">Full rules are under Roles.</span>`}
    ${roleSigil(me.role, 'card-watermark')}
    ${notes.length ? html`<span class="card-block"><span class="card-block-title">Your notes</span>${notes.map((n) => html`<span class="card-text">Night ${n.round}: ${n.text}</span>`)}</span>` : ''}`;
}

/* ---------- Role reveal ---------- */

function viewReveal() {
  const s = state.snap;
  const g = s.game;
  const rv = g.reveal || { seen: [], youSeen: false };
  const open = isOpen('card');
  const seen = rv.seen?.length || 0;
  const total = g.players.length;
  const team = g.me.team || roleInfo(g.me.role).team;
  const body = html`${viewTopbar()}<main class="main" id="main">
    <div class="task-head">
      <h2 class="task-prompt" tabindex="-1">Press and hold your card</h2>
      <p class="task-note">Let go to hide it again. Keep it out of your neighbours’ sight.</p>
    </div>
    <div class="card-stage">
      <button type="button" class="role-card" data-hold="card" data-open="${open}" aria-pressed="${open}" data-testid="role-card">
        <span class="card-face card-back" aria-hidden="${open}">
          <svg class="card-back-mark" aria-hidden="true"><use href="#i-mark"></use></svg>
          <span class="card-back-text">Hold to see your role</span>
          <span class="card-back-sub">Double-tap to keep it open</span>
        </span>
        <span class="card-face card-front" data-team="${team}" aria-hidden="${!open}" data-testid="role-card-front">${roleFace(g)}</span>
      </button>
    </div>
  </main>
  ${actionbar(html`${viewHostStrip(g, { secondary: true })}
    <button type="button" class="btn btn-block btn-big ${rv.youSeen ? '' : 'btn-primary'}" data-act="seen" data-testid="got-it" ${rv.youSeen || ui.busy['game:seen-role'] ? raw('disabled') : ''}>
      ${rv.youSeen ? html`${ico('i-check')}Waiting for the others` : 'Got it'}</button>`,
    html`<span data-testid="reveal-progress">${seen} of ${total} ready</span>`)}`;
  return screen(ui.screenKey, 'reveal', body);
}

/* ---------- Night ---------- */
// Without Peek, every living player's night looks the same: one headline, one tile grid,
// one Confirm and one Done screen, with the same timing, sound and buzz. Role-specific text,
// results and the real choices of the Witch, Cupid and a disagreeing pack live in the private
// panel that Peek opens, which hides itself after a few seconds.

const LIVE_KINDS = ['seer', 'sorceress', 'doctor', 'decoy', 'wolf'];   // the visible pick is the real one
const NIGHT_KEY = 'ww.night';
let mockNightDone = '';
const nightKey = () => { const s = state.snap; return s?.game ? `${s.room.code}:${s.game.round}` : ''; };
const localNightDone = () => { const k = nightKey(); return !!k && (MOCK ? mockNightDone : store.get(NIGHT_KEY, '')) === k; };
function setLocalNightDone() { const k = nightKey(); if (MOCK) mockNightDone = k; else store.set(NIGHT_KEY, k); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Done on screen: the server says so, this phone confirmed tonight, or a wolf already sent a pick.
function visiblyDone(t) {
  if (!t || t.done || localNightDone()) return true;
  return t.kind === 'wolf' && !!t.submitted?.target;
}

// The visible grid never offers yourself: only a Doctor could pick themselves, and that would show.
function visiblePickable(t, p) {
  if (!t || !p.alive || p.id === state.snap.room.you) return false;
  return LIVE_KINDS.includes(t.kind) ? (t.targets || []).includes(p.id) : true;
}

function viewNight() {
  const g = state.snap.game;
  const t = g.night?.task || null;
  let body;
  if (!g.me.alive) body = viewGhostNight(g, t);
  else if (visiblyDone(t)) body = viewNightDone(g);
  else body = viewNightPick(g, t);
  return screen(ui.screenKey, 'night', html`${viewTopbar()}${body}`);
}

// Private hints on the grid while Peek is open (pack picks, the attacked player, why a tile won't pick).
function nightPeekBadges(g, t, p) {
  if (!peeking() || !t) return [];
  const you = state.snap.room.you;
  const out = [];
  const pickers = Object.entries(t.wolf?.picks || {}).filter(([, target]) => target === p.id).map(([wolf]) => (wolf === you ? 'you' : nameOf(wolf)));
  if (pickers.length) out.push(badge(pickers.length === 1 && pickers[0] === 'you' ? 'Your pick' : `Pick: ${listJoin(pickers)}`, 'accent', 'r-werewolf'));
  if ((t.wolf?.locked || []).includes(p.id)) out.push(badge('Victim', 'wolf', 'i-lock'));
  if ((t.witch?.victims || []).includes(p.id)) out.push(badge('Attacked', 'wolf', 'r-werewolf'));
  if (p.alive && p.id !== you && !visiblePickable(t, p) && !inList(g.me?.knows?.pack, p)) out.push(badge('Not tonight', '', 'i-lock'));
  return out;
}

function viewNightPick(g, t) {
  const tiles = g.players.map((p) => viewTile(g, p, { act: 'pick', pickable: visiblePickable(t, p), selected: ui.pick[0] === p.id, badges: nightPeekBadges(g, t, p) }));
  const ready = !!ui.pick[0] && !ui.busy.night;
  return html`<main class="main" id="main" data-testid="task">
    <div class="task-head">
      <h2 class="task-prompt" data-testid="task-prompt">Pick a player, then confirm</h2>
      <p class="task-note">Everyone picks someone. Tap Peek to see in private what your pick does tonight.</p>
    </div>
    <div class="tiles" role="group" aria-label="Players" data-testid="player-grid">${tiles}</div>
  </main>
  ${actionbar(html`<button type="button" class="btn btn-primary btn-block btn-big" data-act="confirm" data-testid="confirm-btn" ${ready ? '' : raw('disabled')}>${ui.pick[0] ? 'Confirm' : 'Pick a player'}</button>`)}`;
}

// Same request timing, sound, buzz and toast for every role. The Witch's and Cupid's visible
// pick is camouflage and sends nothing; the pack's meeting sends {} whoever was picked.
async function confirmNight() {
  const t = state.snap?.game?.night?.task;
  const target = ui.pick[0];
  if (!t || !target || ui.busy.night) return;
  ui.busy.night = true;
  render();
  buzz();
  chime('tap');
  const started = performance.now();
  let res = { ok: true };
  if (LIVE_KINDS.includes(t.kind)) res = await emit('game:night-action', { target });
  else if (t.kind === 'meet') res = await emit('game:night-action', {});
  const wait = 400 - (performance.now() - started);
  if (wait > 0) await sleep(wait);
  ui.busy.night = false;
  if (res.ok) { setLocalNightDone(); toast('Sent.', 'i-check'); }
  else if (res.code === 'RATE_LIMITED' || res.code === 'OFFLINE' || res.code === 'TIMEOUT') showError(res);
  else toast('That pick did not go through. Pick someone else and confirm again.', 'i-alert');
  render();
}

const bigTimer = (g) => {
  const d = g.deadline;
  const ms = msLeft(d, g.paused);
  if (ms == null) return '';
  return html`<div class="timer big" role="timer" data-timer data-testid="big-timer" data-ends="${d.endsAt ?? ''}" data-remaining="${d.remainingMs ?? ''}" data-paused="${!!g.paused}" aria-label="${d.label || 'Time left'}">
    <span class="timer-val big-timer">${g.paused ? 'Paused' : clockText(ms)}</span><span class="timer-label">${d.label || ''}</span></div>`;
};

function viewNightDone(g) {
  const open = peeking();
  return html`<main class="main" id="main" data-testid="night-done">
    <div class="task-done">
      <span class="task-done-mark">${ico('i-moon')}</span>
      <h2 class="task-done-title">Done. Waiting for the village</h2>
      ${bigTimer(g)}
      <p class="task-note">Keep your face still and your phone close.</p>
    </div>
    <button type="button" class="secret" data-act="peek" data-open="${open}" aria-expanded="${open}" aria-controls="private-panel" data-testid="private-open">
      ${ico(open ? 'i-eye' : 'i-eye-off')}
      <span class="secret-text"><strong>${open ? 'Hide your private panel' : 'Open your private panel'}</strong><span class="small muted">Your result and anything left to do. It hides itself after a few seconds.</span></span>
    </button>
  </main>`;
}

function viewGhostNight(g, t) {
  const targets = new Set(t?.targets || g.players.filter((p) => p.alive).map((p) => p.id));
  const guess = g.ghost?.guess || null;
  const pick = ui.pick[0] || null;
  const tiles = g.players.map((p) => viewTile(g, p, { act: 'pick', pickable: !!t && targets.has(p.id), selected: pick === p.id }));
  const same = pick && pick === guess;
  return html`<main class="main" id="main" data-testid="ghost">
    <div class="ghost-note">${ico('i-ghost')}<div><p class="ghost-note-title">You’re a ghost: no talking, no faces.</p><p class="small muted">Stay quiet and keep a straight face until the game ends.</p></div></div>
    <div class="task-head">
      <h2 class="task-prompt" data-testid="task-prompt">${t?.prompt || 'Who will the wolves take tonight?'}</h2>
      <p class="task-note">Just for fun. Your guesses are scored at the end.</p>
    </div>
    <div class="tiles" role="group" aria-label="Players" data-testid="player-grid">${tiles}</div>
  </main>
  ${actionbar(html`<button type="button" class="btn btn-primary btn-block btn-big" data-act="confirm" data-testid="confirm-btn" ${pick && !same && t ? '' : raw('disabled')}>${same ? 'Guess saved' : guess ? 'Change guess' : 'Save guess'}</button>`,
    guess ? `Your guess: ${nameOf(guess)}` : '')}`;
}

/* ---------- The private panel (Peek at night) ---------- */

const PEEK_MS = 8000;
let peekTimer = null;
// Peek toggles on a tap and hides itself after a few seconds without a touch inside it.
function setPeek(open) {
  ui.peekOpen = !!open;
  clearTimeout(peekTimer);
  if (open) peekTimer = setTimeout(() => setPeek(false), PEEK_MS);
  else ui.privNote = '';
  render();
  if (open) requestAnimationFrame(() => document.getElementById('private-title')?.focus({ preventScroll: true }));
}
function keepPeekOpen() {
  if (!ui.peekOpen) return;
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => setPeek(false), PEEK_MS);
}

function pickChips(ids, act, selected, testid) {
  const you = state.snap.room.you;
  return html`<div class="pick-chips" role="group">${ids.map((id) => html`<button type="button" class="pick-chip" data-act="${act}" data-arg="${id}" data-testid="${testid}-${id}" aria-pressed="${selected.includes(id)}">
    ${avatar(nameOf(id), { size: 'avatar-xs' })}<span class="pick-chip-name" translate="no">${id === you ? 'You' : nameOf(id)}</span>${selected.includes(id) ? ico('i-check', 'ico-sm') : ''}</button>`)}</div>`;
}
const privLead = (text) => html`<p class="private-lead">${text}</p>`;
const privNote = (text) => html`<p class="small muted">${text}</p>`;

function privateWolf(t) {
  const w = t.wolf || { slot: 1, slots: 1, picks: {}, locked: [] };
  const you = state.snap.room.you;
  const locked = w.locked || [];
  if (t.done) return privLead(locked.length ? `The pack chose ${listJoin(locked.map(nameOf))}.` : 'The pack made no kill tonight.');
  const picks = Object.entries(w.picks || {});
  const mine = w.picks?.[you] ?? (locked.includes(t.submitted?.target) ? null : t.submitted?.target) ?? null;
  const differ = new Set(picks.map(([, v]) => v)).size > 1;
  return html`${privLead(t.prompt)}
    ${(w.slots || 1) > 1 ? html`<span class="tag wolf-slot" data-testid="wolf-slot">Victim ${Math.min(w.slots, locked.length + 1)} of ${w.slots}</span>` : ''}
    ${locked.length ? privNote(`Already chosen: ${listJoin(locked.map(nameOf))}.`) : ''}
    <div class="private-block" data-testid="pack-picks"><p class="card-block-title">The pack’s picks</p>
      ${picks.length ? html`<ul class="pack-picks">${picks.map(([wolf, target]) => html`<li><span translate="no">${wolf === you ? 'You' : nameOf(wolf)}</span>${ico('i-target', 'ico-sm')}<strong translate="no">${nameOf(target)}</strong></li>`)}</ul>` : privNote('No picks yet.')}
      ${privNote(differ ? 'Picks differ. Agree on one victim; 20 seconds before the end the most-picked player is taken.' : 'When every wolf picks the same player, the kill locks.')}
    </div>
    <div class="private-block"><p class="card-block-title">${mine ? 'Change your pick' : 'Your pick'}</p>${pickChips(t.targets || [], 'priv-wolf', mine ? [mine] : [], 'priv-wolf')}</div>`;
}

function privateWitch(t) {
  const w = t.witch || { waiting: true, victims: [], canHeal: false, canPoison: false };
  const sub = t.submitted || {};
  const used = html`${w.canHeal ? '' : privNote('Your healing potion is used up.')}${w.canPoison ? '' : privNote('Your poison is used up.')}`;
  if (t.done) {
    const parts = [sub.heal ? `you healed ${nameOf(sub.heal)}` : '', sub.poison ? `you poisoned ${nameOf(sub.poison)}` : ''].filter(Boolean);
    return privLead(parts.length ? `Tonight ${listJoin(parts)}.` : 'You used no potion tonight.');
  }
  if (w.waiting) return html`${privLead('The pack is still choosing.')}${privNote('Check back here. Once they lock in you get at least 20 seconds to heal, poison, both or neither. Doing nothing means no potions tonight.')}${used}`;
  const victims = w.victims || [];
  return html`${privLead(t.prompt)}
    ${w.canHeal ? html`<div class="private-block"><p class="card-block-title">Heal</p>
      ${victims.length ? html`${privNote(`The wolves attacked ${listJoin(victims.map(nameOf))}.`)}${pickChips(victims, 'priv-heal', ui.witch.heal ? [ui.witch.heal] : [], 'priv-heal')}` : privNote('Nobody was attacked tonight.')}</div>` : ''}
    ${w.canPoison ? html`<div class="private-block"><p class="card-block-title">Poison</p>${pickChips(t.targets || [], 'priv-poison', ui.witch.poison ? [ui.witch.poison] : [], 'priv-poison')}</div>` : ''}
    ${used}
    <div class="private-actions">
      <button type="button" class="btn btn-primary btn-block" data-act="priv-witch" data-arg="use" data-testid="priv-witch-use" ${ui.witch.heal || ui.witch.poison ? '' : raw('disabled')}>Use potions</button>
      <button type="button" class="btn btn-block btn-sm" data-act="priv-witch" data-arg="pass" data-testid="priv-witch-pass">Pass tonight</button>
    </div>`;
}

function privateCupid(t) {
  if (t.done) return privLead(Array.isArray(t.submitted?.targets) ? `You linked ${listJoin(t.submitted.targets.map(nameOf))}.` : 'Your arrow is spent.');
  return html`${privLead(t.prompt)}${privNote('Pick two players. You may pick yourself. They learn at dawn that they are in love.')}
    ${pickChips(t.targets || [], 'priv-cupid', ui.cupid, 'priv-cupid')}
    <button type="button" class="btn btn-primary btn-block" data-act="priv-cupid-send" data-testid="priv-cupid-send" ${ui.cupid.length === 2 ? '' : raw('disabled')}>${ui.cupid.length === 2 ? `Link ${listJoin(ui.cupid.map(nameOf))}` : 'Pick two players'}</button>`;
}

function privateDoctor(g, t) {
  const you = state.snap.room.you;
  const who = (id) => (id === you ? 'yourself' : nameOf(id));
  if (t.done) return privLead(t.submitted?.target ? `You are protecting ${who(t.submitted.target)} tonight.` : 'You protected nobody tonight.');
  const notAgain = g.players.filter((p) => p.alive && !(t.targets || []).includes(p.id)).map((p) => p.id);
  const selfOk = (t.targets || []).includes(you);
  return html`${privLead(t.prompt)}
    ${notAgain.length ? html`<p class="small" data-testid="doctor-not-again">Not ${listJoin(notAgain.map(who))} again: you protected them last night.</p>` : ''}
    ${privNote('The player you confirm on the main screen is the one you protect.')}
    ${selfOk ? html`<button type="button" class="btn btn-block btn-sm" data-act="priv-doctor-self" data-testid="priv-doctor-self">Protect yourself instead</button>` : ''}`;
}

function privateBody(g, t) {
  if (!t) return privLead('Nothing to do tonight.');
  switch (t.kind) {
    case 'seer':
    case 'sorceress':
      if (t.result?.text) return html`<p class="private-result" data-tone="${t.result.wolf || t.result.seer ? 'wolf' : 'good'}" data-testid="private-result">${t.result.text}</p>`;
      return html`${privLead(t.prompt)}${privNote('The player you confirm on the main screen is the one you check. The answer appears here.')}`;
    case 'doctor': return privateDoctor(g, t);
    case 'decoy':
      return visiblyDone(t) ? html`${privLead(t.submitted?.target ? `You suspect ${nameOf(t.submitted.target)}.` : 'Nothing else to do tonight.')}${privNote('Your pick shows up in the end-of-game recap.')}`
        : html`${privLead(t.prompt)}${privNote('You have no night power. Pick anyone you suspect; it shows up in the end-of-game recap.')}`;
    case 'meet': return html`${privLead(t.prompt)}${privNote('No kill tonight. Confirm any player on the main screen once you have seen your pack.')}`;
    case 'wolf': return privateWolf(t);
    case 'witch': return privateWitch(t);
    case 'cupid': return privateCupid(t);
    default: return privLead(t.prompt || 'Nothing to do tonight.');
  }
}

function viewPrivatePanel() {
  const g = state.snap?.game;
  if (!g || g.phase !== 'night' || !g.me?.alive || !ui.peekOpen) return '';
  const info = roleInfo(g.me.role);
  const lines = knowsLines(g);
  const notes = g.me.notes || [];
  return html`<section class="private-panel" id="private-panel" data-key="private" aria-labelledby="private-title" data-testid="private-panel">
    <div class="private-head">
      <span class="role-ico" data-team="${info.team}">${roleSigil(g.me.role)}</span>
      <div class="grow"><h2 class="private-title" id="private-title" tabindex="-1">${info.name}</h2><p class="small muted">Private. Hides itself after a few seconds.</p></div>
      <button type="button" class="icon-btn icon-btn-plain" data-act="peek" data-testid="private-close" aria-label="Hide the private panel">${ico('i-x')}</button>
    </div>
    <div class="private-body">
      ${privateBody(g, g.night?.task || null)}
      ${ui.privNote ? html`<p class="private-status" data-testid="private-status">${ui.privNote}</p>` : ''}
      ${lines.length || notes.length ? html`<div class="private-block">
        ${lines.length ? html`<p class="card-block-title">What you know</p>${lines.map((l) => html`<p class="small">${l}</p>`)}` : ''}
        ${notes.length ? html`<p class="card-block-title">Your notes</p>${notes.map((n) => html`<p class="small">Night ${n.round}: ${n.text}</p>`)}` : ''}
      </div>` : ''}
    </div>
  </section>`;
}

// Private actions answer inside the panel only: no toast, no buzz, no live region.
async function privateAction(payload) {
  keepPeekOpen();
  ui.privNote = 'Sending…';
  render();
  const res = await emit('game:night-action', payload);
  ui.privNote = res.ok ? 'Saved.' : res.code === 'RATE_LIMITED' ? 'Too many taps. Wait a second and try again.' : res.error || 'That did not go through. Try again.';
  keepPeekOpen();
  render();
  return res;
}

// The same held-down row for every role (used for the private news at dawn).
function secretRow(kind, title, line, testid) {
  const open = isOpen(kind);
  return html`<button type="button" class="secret" data-hold="${kind}" data-open="${open}" data-tone="${open ? line.tone : ''}" aria-pressed="${open}" data-testid="${testid}">
    ${ico(open ? 'i-eye' : 'i-eye-off')}
    <span class="secret-text">${open ? html`<strong>${line.text}</strong>` : html`<strong>${title}</strong><span class="small muted">Press and hold. Double-tap to keep it open.</span>`}</span>
  </button>`;
}

/* ---------- Day ---------- */

function viewDay() {
  const g = state.snap.game;
  const stage = g.day?.stage;
  const body = stage === 'shot' ? viewShot(g) : stage === 'vote' ? viewVote(g) : stage === 'verdict' ? viewVerdict(g) : viewDiscussion(g);
  return screen(ui.screenKey, `day-${stage || 'discussion'}`, html`${viewTopbar()}${body}`);
}

const ghostDay = (g) => (g.me && !g.me.alive ? html`<div class="ghost-note" data-testid="ghost-banner">${ico('i-ghost')}<div><p class="ghost-note-title">You’re a ghost. Stay silent.</p><p class="small muted">No talking and no faces until the game ends.</p></div></div>` : '');

function viewDawn(g) {
  const anns = g.day?.announcements || [];
  const deaths = anns.filter((a) => a.kind === 'death');
  const infos = anns.filter((a) => a.kind === 'info');
  const priv = anns.filter((a) => a.kind === 'private');
  const news = priv.length ? { text: priv.map((a) => a.text).join(' '), tone: '' } : { text: 'Nothing new for you today.', tone: '' };
  return html`<section class="dawn" aria-labelledby="dawn-title" data-testid="dawn">
    <h2 class="dawn-title" id="dawn-title" tabindex="-1">${ico('i-sun')}Dawn of day ${g.round}</h2>
    ${deaths.length ? html`<ul class="deaths">${deaths.map((a) => {
      const p = gamePlayer(g, a.playerId);
      const shown = p ? revealedText(p) : '';
      return html`<li class="death" data-testid="death-${a.playerId || 'x'}">${avatar(p?.name || nameOf(a.playerId), { dead: true })}
        <div class="death-main"><p class="death-name">${a.text}</p>${shown ? html`<p class="death-sub">${shown}</p>` : ''}</div>
        ${p?.revealed?.kind === 'role' ? html`<span class="role-ico" data-team="${roleInfo(p.revealed.value).team}">${roleSigil(p.revealed.value)}</span>` : ico('i-skull')}</li>`;
    })}</ul>` : infos.length ? '' : html`<p class="info-line">${ico('i-check')}Nobody died in the night.</p>`}
    ${infos.map((a) => html`<p class="info-line">${ico('i-info')}<span>${a.text}</span></p>`)}
    ${g.me ? secretRow('news', 'Your private news', news, 'news-hold') : ''}
  </section>`;
}

function rolesInPlay(g) {
  return html`<section class="section" aria-labelledby="inplay-title"><div class="section-head"><h2 class="section-title" id="inplay-title">Roles in this game</h2></div>${lineupChips(g.rolesInPlay)}</section>`;
}

function viewLog(entries, title = 'What happened', testid = 'game-log') {
  const groups = [];
  for (const e of entries || []) {
    const key = `${e.phase}:${e.round}`;
    let grp = groups.find((x) => x.key === key);
    if (!grp) { grp = { key, phase: e.phase, round: e.round, items: [] }; groups.push(grp); }
    grp.items.push(e.text);
  }
  return html`<section class="section" aria-labelledby="${testid}-title" data-testid="${testid}">
    <div class="section-head"><h2 class="section-title" id="${testid}-title">${title}</h2></div>
    ${groups.length ? html`<div class="panel log">${groups.map((grp) => html`<div class="log-round">
      <p class="log-round-title">${ico(grp.phase === 'night' ? 'i-moon' : 'i-sun')}${grp.phase === 'night' ? 'Night' : 'Day'} ${grp.round}</p>
      ${grp.items.map((t) => html`<p class="log-item">${t}</p>`)}</div>`)}</div>` : html`<p class="empty">Nothing yet.</p>`}
  </section>`;
}

function viewDiscussion(g) {
  const host = state.snap.room.isHost;
  const note = g.paused ? 'The host paused the timer.' : g.deadline ? 'Voting opens when the timer runs out.' : 'The host opens the vote when you are done.';
  return html`<main class="main" id="main" data-testid="discussion">
    ${ghostDay(g)}
    ${viewDawn(g)}
    <section class="section" aria-labelledby="grid-title">
      <div class="section-head"><h2 class="section-title" id="grid-title">The village</h2><span class="section-note">${g.players.filter((p) => p.alive).length} alive</span></div>
      ${staticTiles(g)}
    </section>
    ${rolesInPlay(g)}
    ${viewLog(g.log)}
  </main>
  ${actionbar(viewHostStrip(g), host ? '' : note)}`;
}

function viewShot(g) {
  const d = g.day;
  const you = state.snap.room.you;
  if (d.shooter === you && d.shot) {
    const targets = new Set(d.shot.targets || []);
    const pick = ui.pick[0] || null;
    return html`<main class="main" id="main" data-testid="shot-hunter">
      <div class="task-head">
        <h2 class="task-prompt" tabindex="-1">Take someone with you</h2>
        <p class="task-note">You were the Hunter. Pick one living player to shoot before the timer runs out.</p>
      </div>
      <div class="tiles" role="group" aria-label="Players" data-testid="player-grid">${g.players.map((p) => viewTile(g, p, { act: 'pick', pickable: targets.has(p.id), selected: pick === p.id }))}</div>
    </main>
    ${actionbar(html`<button type="button" class="btn btn-danger btn-block btn-big" data-act="shoot" data-testid="shoot-btn" ${pick && !ui.busy['game:shoot'] ? '' : raw('disabled')}>${ico('r-hunter')}${pick ? `Shoot ${nameOf(pick)}` : 'Pick a player'}</button>`)}`;
  }
  return html`<main class="main" id="main" data-testid="shot-wait">
    ${ghostDay(g)}
    <div class="task-done">
      <span class="task-done-mark aiming">${ico('r-hunter')}</span>
      <h2 class="task-done-title" tabindex="-1">The Hunter takes aim</h2>
      <p class="lede">${d.shooter ? `${nameOf(d.shooter)} was the Hunter and gets one last shot.` : 'The Hunter gets one last shot.'}</p>
      ${bigTimer(g)}
    </div>
    ${d.announcements?.length ? viewDawn(g) : ''}
  </main>
  ${actionbar(viewHostStrip(g))}`;
}

function viewVote(g) {
  const v = g.day.vote || { eligible: [], voted: [], myVote: null, blocked: [], live: null, canVote: false };
  const you = state.snap.room.you;
  const waiting = (v.eligible || []).filter((id) => !(v.voted || []).includes(id)).map(nameOf);
  const mine = ui.pendingVote ?? v.myVote;
  const blocked = new Set(v.blocked || []);
  const liveBy = {};
  for (const [voter, target] of Object.entries(v.live || {})) (liveBy[target] = liveBy[target] || []).push(nameOf(voter));
  const candidates = g.players.filter((p) => p.alive && p.id !== you);
  const tiles = (v.canVote ? candidates : g.players).map((p) => {
    const badges = [];
    if (peeking() && blocked.has(p.id)) badges.push(badge('Your lover', 'love', 'i-lock'));
    const votesFor = v.live ? liveBy[p.id] || [] : [];
    if (votesFor.length) badges.unshift(badge(plural(votesFor.length, 'vote'), 'accent', 'i-ballot'));
    const sub = votesFor.length ? listJoin(votesFor) : undefined;
    return v.canVote
      ? viewTile(g, p, { act: 'vote', pickable: !blocked.has(p.id), selected: mine === p.id, badges, sub })
      : viewTile(g, p, { badges, sub });
  });
  const note = v.canVote ? (mine ? `Your vote: ${nameOf(mine)}. Tap someone else to change it.` : 'Tap a player to vote for them, or skip.') : '';
  return html`<main class="main" id="main" data-testid="vote">
    ${ghostDay(g)}
    <div class="waiting" data-testid="vote-waiting" aria-live="polite">
      <span class="waiting-label">${waiting.length ? 'Waiting for' : 'Everyone has voted'}</span>
      ${waiting.length ? html`<span class="waiting-names" translate="no">${listJoin(waiting)}</span>` : ''}
      <span class="waiting-count num" data-testid="vote-count">${(v.voted || []).length} of ${(v.eligible || []).length} voted</span>
    </div>
    <div class="task-head">
      <h2 class="task-prompt" tabindex="-1">${v.canVote ? 'Who should leave the village?' : 'The village is voting'}</h2>
      <p class="rule-note" data-testid="tie-rule">${ico('i-info')}<span>A tie, or Skip on top, means nobody is eliminated.</span></p>
    </div>
    <div class="tiles" role="${v.canVote ? 'group' : 'list'}" aria-label="Players" data-testid="player-grid">${tiles}</div>
    ${v.live && liveBy.skip ? html`<p class="small muted">Skip so far: ${listJoin(liveBy.skip)}.</p>` : ''}
  </main>
  ${actionbar(html`${viewHostStrip(g)}${v.canVote ? html`<button type="button" class="btn btn-block skip-btn" data-act="vote" data-arg="skip" data-testid="vote-skip" aria-pressed="${mine === 'skip'}">
      ${ico(mine === 'skip' ? 'i-check' : 'i-skip')}${mine === 'skip' ? 'You chose to skip' : 'Skip: nobody leaves'}${v.live && liveBy.skip ? html`<span class="chip-count">${liveBy.skip.length}</span>` : ''}</button>` : ''}`, note)}`;
}

function viewVerdict(g) {
  const v = g.day.verdict;
  if (!v) return html`<main class="main" id="main"><p class="lede">Counting the votes…</p></main>`;
  const elim = v.eliminated ? gamePlayer(g, v.eliminated) : null;
  const byTarget = {};
  for (const [voter, target] of Object.entries(v.votes || {})) (byTarget[target] = byTarget[target] || []).push(voter);
  const rows = Object.entries(byTarget).sort((a, b) => b[1].length - a[1].length || (a[0] === 'skip') - (b[0] === 'skip'));
  const top = rows[0]?.[1].length || 0;
  const abstained = (g.day.vote?.eligible || []).filter((id) => !(id in (v.votes || {})));
  const icon = { eliminated: 'i-skull', prince: 'r-prince', tie: 'i-skip', skip: 'i-skip', none: 'i-skip' }[v.outcome] || 'i-ballot';
  const host = state.snap.room.isHost;
  return html`<main class="main" id="main" data-testid="verdict" data-outcome="${v.outcome}">
    <section class="verdict-result" aria-labelledby="verdict-title">
      ${elim ? avatar(elim.name, { size: 'avatar-lg', dead: v.outcome === 'eliminated' }) : html`<span class="task-done-mark">${ico(icon)}</span>`}
      <h2 class="verdict-text" id="verdict-title" tabindex="-1" data-testid="verdict-text">${v.text}</h2>
      ${elim && revealedText(elim) ? html`<span class="chip" data-team="${elim.revealed?.kind === 'role' ? roleInfo(elim.revealed.value).team : ''}">${elim.revealed?.kind === 'role' ? roleSigil(elim.revealed.value) : ico('i-info')}${revealedText(elim)}</span>` : ''}
    </section>
    <section class="section" aria-labelledby="ballots-title">
      <div class="section-head"><h2 class="section-title" id="ballots-title">Every vote</h2></div>
      ${rows.length ? html`<ul class="ballots" data-testid="ballots">${rows.map(([target, voters]) => html`<li class="ballot" data-top="${voters.length === top}" data-testid="ballot-${target}">
        <span class="ballot-target" translate="no">${target === 'skip' ? 'Skip' : nameOf(target)}</span><span class="ballot-count">${voters.length}</span>
        <span class="ballot-voters">${voters.map((id) => `${nameOf(id)} voted ${target === 'skip' ? 'Skip' : nameOf(target)}`).join('. ')}.</span>
      </li>`)}</ul>` : html`<p class="empty">Nobody voted.</p>`}
      ${abstained.length ? html`<p class="small muted">No vote from ${listJoin(abstained.map(nameOf))}.</p>` : ''}
    </section>
    ${ghostDay(g)}
  </main>
  ${actionbar(viewHostStrip(g), host ? '' : g.deadline ? 'Night falls when the timer runs out.' : 'Night falls when the host is ready.')}`;
}

/* ---------- Game over and late arrival ---------- */

const CAUSE = {
  night: 'Died in the night', wolves: 'Killed by the wolves', poison: 'Poisoned', vote: 'Voted out',
  hunter: 'Shot by the Hunter', heartbreak: 'Died of a broken heart',
};
const WIN_SIGIL = { village: 'r-villager', wolves: 'r-werewolf', jester: 'r-jester', lovers: 'i-heart' };

function viewOver() {
  const s = state.snap;
  const g = s.game;
  const w = g.winner || { team: 'village', winners: [], title: 'The game is over', text: '' };
  const winners = new Set(w.winners || []);
  const you = s.room.you;
  const host = s.room.isHost;
  const score = g.ghost?.score;
  const body = html`${viewTopbar()}<main class="main" id="main" data-testid="game-over">
    <section class="winner" data-team="${w.team}" data-testid="winner-banner" aria-labelledby="winner-title">
      <span class="winner-sigil">${ico(WIN_SIGIL[w.team] || 'i-trophy')}</span>
      <h2 class="winner-title" id="winner-title" tabindex="-1">${w.title}</h2>
      ${w.text ? html`<p class="winner-text">${w.text}</p>` : ''}
      ${g.me ? html`<span class="tag ${winners.has(you) ? 'tag-ok' : 'tag-quiet'}" data-testid="you-result">${winners.has(you) ? html`${ico('i-trophy', 'ico-xs')}You won` : 'You lost this one'}</span>` : ''}
    </section>
    ${score ? html`<p class="status-line" data-testid="ghost-score">${ico('i-ghost')}<span>Your ghost guesses: ${score.right} of ${score.total} right</span></p>` : ''}
    <section class="section" aria-labelledby="cast-title">
      <div class="section-head"><h2 class="section-title" id="cast-title">Every role</h2><span class="section-note">${winners.size} won</span></div>
      <ul class="panel panel-tight cast" data-testid="cast">${g.players.map((p) => {
        const info = roleInfo(p.role);
        const won = winners.has(p.id);
        return html`<li class="cast-row" data-won="${won}" data-key="c:${p.id}" data-testid="cast-${p.id}">
          ${avatar(p.name, { dead: !p.alive })}
          <div class="cast-main"><p class="cast-name" translate="no">${p.name}${p.id === you ? html` <span class="muted">(you)</span>` : ''}</p>
            <p class="cast-role"><span class="team-${info.team}">${roleSigil(p.role)}</span>${info.name}${p.alive ? ', alive' : `, ${(CAUSE[p.cause] || 'dead').toLowerCase()}`}</p></div>
          ${won ? html`<span class="tag tag-ok">${ico('i-trophy', 'ico-xs')}Won</span>` : ''}
        </li>`;
      })}</ul>
    </section>
    ${viewLog(g.history || g.log, 'What really happened', 'recap')}
  </main>
  ${actionbar(host ? html`<button type="button" class="btn btn-primary btn-block btn-big" data-act="play-again" data-testid="play-again" ${ui.busy['host:play-again'] ? raw('disabled') : ''}>${ico('i-refresh')}Play again</button>
      <button type="button" class="btn btn-block btn-sm" data-act="play-again" data-testid="change-setup">${ico('i-gear')}Change setup</button>` : '',
    host ? 'Same players and settings. Everyone gets ready again.' : 'Waiting for the host to start the next game.')}`;
  return screen(ui.screenKey, 'over', body);
}

function viewLate() {
  const g = state.snap.game;
  const body = html`${viewTopbar()}<main class="main" id="main" data-testid="late">
    <div class="panel info-line" role="status">${ico('i-clock')}<div><p class="h3">Game in progress: you’ll play the next game</p><p class="muted">You’re on the list for the next game. Watch along until this one ends.</p></div></div>
    <section class="section" aria-labelledby="late-grid"><div class="section-head"><h2 class="section-title" id="late-grid">The village</h2></div>${staticTiles(g)}</section>
    ${rolesInPlay(g)}
    ${viewLog(g.log)}
  </main>`;
  return screen(ui.screenKey, 'late', body);
}

/* ---------- Host controls ---------- */

const HOST = {
  'start-night': { label: 'Start night 1 now', icon: 'i-moon', title: 'Start the night now?', text: 'Anyone still reading their role will have to catch up.', yes: 'Start the night' },
  'start-vote': { label: 'Start vote', icon: 'i-ballot', title: 'End the discussion?', text: 'Voting opens for everyone straight away.', yes: 'Start the vote' },
  'end-vote': { label: 'End vote', icon: 'i-ballot', title: 'Close the vote now?', text: 'Anyone who has not voted abstains.', yes: 'Close the vote' },
  'skip-shot': { label: 'Skip shot', icon: 'i-skip', title: 'Skip the Hunter’s shot?', text: 'The Hunter is offline, so nobody will be shot.', yes: 'Skip the shot' },
  'next-night': { label: 'Night falls', icon: 'i-moon', title: 'Start the next night?', text: 'Everyone moves on to their night task.', yes: 'Night falls' },
  pause: { label: 'Pause', icon: 'i-pause', title: 'Pause the timer?', text: 'The countdown stops for everyone until you resume it.', yes: 'Pause' },
  resume: { label: 'Resume', icon: 'i-play', title: 'Resume the timer?', text: 'The countdown carries on from where it stopped.', yes: 'Resume' },
  extend: { label: '+30\u00A0s', icon: 'i-plus', title: 'Add 30 seconds?', text: 'Everyone gets 30 more seconds on this timer.', yes: 'Add 30 seconds' },
};
const MINOR = ['pause', 'resume', 'extend'];

function viewHostStrip(g, { secondary = false } = {}) {
  if (!state.snap.room.isHost) return '';
  const acts = (g.hostActions || []).filter((a) => HOST[a]);
  if (!acts.length) return '';
  const major = acts.filter((a) => !MINOR.includes(a));
  const minor = acts.filter((a) => MINOR.includes(a));
  const btn = (a, cls) => html`<button type="button" class="btn ${cls}" data-act="host" data-arg="${a}" data-testid="host-${a}" ${ui.busy[`host:${a}`] ? raw('disabled') : ''}>${ico(HOST[a].icon)}${HOST[a].label}</button>`;
  return html`<div class="stack" style="gap:6px" data-testid="host-controls">
    <p class="host-label">${ico('i-crown')}Host controls</p>
    <div class="host-row">${minor.map((a) => btn(a, 'btn-sm'))}${major.map((a) => btn(a, secondary ? 'btn-sm' : 'btn-primary'))}</div>
  </div>`;
}

/* ---------- Sheets ---------- */

function viewSheet() {
  if (!ui.sheet || !state.snap && ui.sheet !== 'guide' && ui.sheet !== 'menu') return '';
  const [kind, arg] = ui.sheet.split(':');
  const make = { code: sheetCode, roles: sheetRoles, menu: sheetMenu, guide: sheetGuide, player: sheetPlayer, transfer: sheetTransfer }[kind];
  const sheet = make ? make(arg) : null;
  if (!sheet) return '';
  return html`<div data-key="sheet:${ui.sheet}">
    <button type="button" class="scrim" data-act="close-sheet" tabindex="-1" aria-label="Close" data-testid="sheet-scrim"></button>
    <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" data-testid="sheet-${kind}">
      <div class="sheet-head"><h2 class="sheet-title" id="sheet-title">${sheet.title}</h2>
        <button type="button" class="icon-btn icon-btn-plain" data-act="close-sheet" data-testid="sheet-close" aria-label="Close">${ico('i-x')}</button></div>
      <div class="sheet-body">${sheet.body}</div>
    </section>
  </div>`;
}

function sheetCode() {
  const code = state.snap?.room?.code;
  if (!code) return null;
  return {
    title: `Room ${code}`,
    body: html`<div class="qr-big"><img src="${qrSrc(code)}" alt="QR code that opens the link to room ${code}" width="276" height="276"></div>
      <p class="big-code" data-testid="sheet-code" translate="no">${code}</p>
      <p class="link-box" data-testid="join-link" translate="no">${joinLink(code)}</p>
      <div class="code-actions">
        <button type="button" class="btn btn-sm" data-act="share" data-testid="sheet-share">${ico('i-share')}Share link</button>
        <button type="button" class="btn btn-sm" data-act="copy-link" data-testid="sheet-copy">${ico('i-copy')}Copy link</button>
      </div>`,
  };
}

function roleRows(counts, { rules = false } = {}) {
  const ids = ROLE_ORDER.filter((id) => (counts ? counts[id] > 0 : true));
  return html`<div class="role-list">${ids.map((id) => {
    const info = roleInfo(id);
    return html`<div class="role-row" data-key="rr:${id}" style="align-items:flex-start">
      <span class="role-ico" data-team="${info.team}">${roleSigil(id)}</span>
      <span class="role-row-main"><span class="role-row-name">${info.name}${counts && counts[id] > 1 ? ` ×${counts[id]}` : ''} <span class="small team-${info.team}">${TEAM_NAME[info.team]}</span></span>
        <span class="role-row-sub">${rules ? info.rules : info.summary}</span></span>
    </div>`;
  })}</div>`;
}

function sheetRoles() {
  const g = state.snap?.game;
  const counts = g ? g.rolesInPlay : state.snap?.room?.deck?.roles;
  return {
    title: g ? 'Roles in this game' : 'Roles in the line-up',
    body: html`<p class="small muted">Everyone sees which roles are in play. Who holds them stays secret.</p>${roleRows(counts, { rules: true })}`,
  };
}

const sheetGuide = () => ({ title: 'How each role works', body: html`<p class="small muted">The app is the moderator. Talk out loud by day; at night everyone taps their own task.</p>${roleRows(null, { rules: true })}` });

function sheetMenu() {
  const s = state.snap;
  const g = s?.game;
  const host = s?.room?.isHost;
  return {
    title: 'Menu',
    body: html`
      ${s ? html`<button type="button" class="btn btn-block btn-sm" data-act="sheet" data-arg="code" data-testid="menu-code">${ico('i-qr')}Room ${s.room.code}: show code and QR</button>` : ''}
      <div class="panel rows">
        ${switchRow('Narrate on this phone', 'Reads phases and deaths aloud. The iPhone silent switch mutes it.', prefs.narration, 'pref', 'narration', 'narration-toggle')}
        ${switchRow('Sounds', 'The same chime for everyone at night and on confirm', prefs.sounds, 'pref', 'sounds', 'sound-toggle')}
        ${switchRow('Vibration', 'The same buzz for everyone. Android only.', prefs.haptics, 'pref', 'haptics', 'haptics-toggle')}
      </div>
      <button type="button" class="btn btn-block btn-sm" data-act="sheet" data-arg="guide" data-testid="guide-btn">${ico('i-cards')}How each role works</button>
      ${host && g ? html`<div class="stack">
        <p class="host-label">${ico('i-crown')}Host</p>
        <button type="button" class="btn btn-block btn-sm" data-act="sheet" data-arg="transfer" data-testid="transfer-btn">${ico('i-users')}Hand host to someone else</button>
        ${g.phase !== 'over' ? html`<button type="button" class="btn btn-block btn-sm" data-act="end-game" data-testid="host-end-game">${ico('i-flag')}End the game for everyone</button>` : ''}
      </div>` : ''}
      ${s ? html`<button type="button" class="btn btn-quiet" data-act="leave" data-testid="leave-btn">${ico('i-door')}Leave the room</button>` : ''}`,
  };
}

function sheetPlayer(id) {
  const p = state.snap?.room?.players?.find((x) => x.id === id);
  if (!p || !state.snap.room.isHost) return null;
  return {
    title: p.name,
    body: html`<div class="stack">
      <button type="button" class="btn btn-block btn-sm" data-act="transfer" data-arg="${p.id}" data-testid="make-host-${p.id}" ${p.connected && !p.left ? '' : raw('disabled')}>${ico('i-crown')}Make ${p.name} the host</button>
      ${state.snap.game ? '' : html`<button type="button" class="btn btn-danger btn-block btn-sm" data-act="kick" data-arg="${p.id}" data-testid="kick-${p.id}">${ico('i-door')}Remove from the room</button>`}
      ${p.connected ? '' : html`<p class="small muted">${p.name} is offline. Only a connected player can become host.</p>`}
    </div>`,
  };
}

function sheetTransfer() {
  const r = state.snap?.room;
  if (!r?.isHost) return null;
  const others = r.players.filter((p) => p.id !== r.you && p.connected && !p.left);
  return {
    title: 'Hand host to',
    body: others.length ? html`<div class="stack">${others.map((p) => html`<button type="button" class="btn btn-block btn-sm" data-act="transfer" data-arg="${p.id}" data-testid="transfer-${p.id}">${avatar(p.name, { size: 'avatar-sm' })}${p.name}</button>`)}</div>`
      : html`<p class="empty">Nobody else is connected right now.</p>`,
  };
}

/* ---------- Dialogs ---------- */

function viewDialog() {
  const s = state.snap;
  // The host's approve prompt comes from the snapshot, so it survives a refresh.
  const req = s?.room?.isHost && !state.away ? s.room.reclaims?.[0] : null;
  if (req) {
    return dialogBox('reclaim', html`<h2 class="dialog-title" id="dialog-title">${req.name} wants their seat back</h2>
      <p class="dialog-text">Someone on a new phone is asking to take over ${req.name}’s seat. Allow it only if ${req.name} is the one asking.</p>
      <div class="dialog-actions">
        <button type="button" class="btn btn-primary btn-block" data-act="approve" data-arg="${req.requestId}:yes" data-testid="reclaim-allow">Give ${req.name} the seat</button>
        <button type="button" class="btn btn-block" data-act="approve" data-arg="${req.requestId}:no" data-testid="reclaim-refuse">Refuse</button>
      </div>`);
  }
  if (ui.reclaim?.stage === 'offer') {
    const r = ui.reclaim;
    return dialogBox('reclaim-offer', html`<h2 class="dialog-title" id="dialog-title">Is ${r.name} you?</h2>
      <p class="dialog-text">${r.name} is in room ${r.code}, but that phone is offline. If it was yours, ask the host to move the seat to this phone.</p>
      <div class="dialog-actions">
        <button type="button" class="btn btn-primary btn-block" data-act="reclaim" data-testid="reclaim-btn">Ask the host</button>
        <button type="button" class="btn btn-block" data-act="reclaim-cancel" data-testid="reclaim-other">Use another name</button>
      </div>`);
  }
  const d = ui.dialog;
  if (!d) return '';
  return dialogBox('confirm', html`<h2 class="dialog-title" id="dialog-title">${d.title}</h2>
    ${d.text ? html`<p class="dialog-text">${d.text}</p>` : ''}
    <div class="dialog-actions">
      <button type="button" class="btn btn-block ${d.tone === 'danger' ? 'btn-danger' : 'btn-primary'}" data-act="dialog-yes" data-testid="dialog-confirm">${d.yes || 'Confirm'}</button>
      <button type="button" class="btn btn-block" data-act="dialog-no" data-testid="dialog-cancel">${d.no || 'Cancel'}</button>
    </div>`);
}

const dialogBox = (key, inner) => html`<div class="dialog-wrap" data-key="dialog:${key}" data-testid="modal-${key}">
  <section class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title">${inner}</section></div>`;

function confirmThen(opts, run) {
  ui.dialog = { ...opts, run };
  render();
  requestAnimationFrame(() => document.querySelector('[data-testid="dialog-confirm"]')?.focus());
}

/* ---------- Full-screen moments ---------- */

const DEATH = {
  night: ['The night got you', 'You did not survive the night.'],
  wolves: ['The werewolves got you', 'The pack chose you tonight.'],
  poison: ['You were poisoned', 'Someone used the poison on you.'],
  vote: ['The village voted you out', 'The vote went against you.'],
  hunter: ['The Hunter took you down', 'You were the Hunter’s last shot.'],
  heartbreak: ['You died of a broken heart', 'Your lover died, and you followed.'],
};

function viewOverlay() {
  const s = state.snap;
  if (ui.death && s?.game) {
    const [title, text] = DEATH[ui.death] || DEATH.night;
    return html`<div class="overlay death-moment" data-key="overlay:death" role="alertdialog" aria-modal="true" aria-labelledby="death-title" data-testid="death-moment">
      <svg class="ico death-sigil" aria-hidden="true"><use href="#i-skull"></use></svg>
      <h2 class="overlay-title" id="death-title">${title}</h2>
      <p class="overlay-text">${text} You’re a ghost now: no talking, no faces, and keep your role to yourself.</p>
      <button type="button" class="btn btn-block" data-act="death-ok" data-testid="death-ok" style="max-width:320px">Continue as a ghost</button>
    </div>`;
  }
  const r = s?.room;
  if (r && !s.game && !state.away && r.countdownEndsAt && r.countdownEndsAt > serverNow() - 500) {
    const n = Math.max(1, Math.ceil((r.countdownEndsAt - serverNow()) / 1000));
    const me = r.players.find((p) => p.id === r.you);
    return html`<div class="overlay" data-key="overlay:countdown" role="status" data-testid="countdown">
      <p class="overlay-title">Everyone is ready</p>
      <p class="overlay-num" data-countdown="${r.countdownEndsAt}" aria-hidden="true">${n}</p>
      <p class="overlay-text">The cards are being dealt. Get your phone close and your poker face ready.</p>
      ${me?.ready ? html`<button type="button" class="btn" data-act="ready" data-testid="countdown-cancel">Not ready yet</button>` : ''}
    </div>`;
  }
  return '';
}

function viewPeekCard() {
  const g = state.snap?.game;
  if (!g?.me || !isOpen('myrole') || state.away) return '';
  const team = g.me.team || roleInfo(g.me.role).team;
  return html`<div class="peek-card card-front" data-key="peek" data-team="${team}" role="status" data-testid="my-role-card">${roleFace(g, { compact: true })}</div>`;
}

/* ---------- Actions ---------- */

const meInRoom = () => state.snap?.room?.players?.find((p) => p.id === state.snap.room.you) || null;
const settingsPatch = (patch) => send('lobby:settings', { patch }, { key: 'lobby:settings' });

async function homeSubmit(kind) {
  const name = ui.home.name.trim();
  const code = ui.home.code.trim().toUpperCase();
  const errors = {};
  if (!name) errors.name = 'Enter your name first.';
  else if (Array.from(name).length > 16) errors.name = 'Names can be up to 16 characters.';
  if (kind === 'join' && !/^[A-Z]{4}$/.test(code)) errors.code = code ? 'Room codes are 4 letters, like FANG.' : 'Enter the 4-letter room code.';
  ui.home.errors = errors;
  if (errors.name || errors.code) {
    render();
    document.getElementById(errors.name ? 'name-input' : 'join-code')?.focus();
    return;
  }
  store.set(NAME_KEY, name);
  ui.home.busy = kind;
  render();
  const res = kind === 'create' ? await emitRetry('room:create', { name }) : await emitRetry('room:join', { code, name });
  ui.home.busy = false;
  if (res.ok) {
    saveSeat({ code: res.code || code, playerId: res.playerId, token: res.token, name });
    ui.notice = null;
    state.away = false;
  } else if (res.code === 'NAME_TAKEN_OFFLINE') {
    ui.reclaim = { stage: 'offer', code, name };
  } else if (res.code === 'NAME_TAKEN' || res.code === 'BAD_NAME') {
    ui.home.errors = { name: res.error };
  } else if (res.code === 'NO_ROOM' || res.code === 'BAD_CODE' || res.code === 'ROOM_FULL') {
    ui.home.errors = { code: res.error };
  } else {
    showError(res);
  }
  render();
}

async function rejoin() {
  const seat = savedSeat();
  if (!seat || ui.busy['room:resume']) return;
  ui.busy['room:resume'] = true;
  render();
  const res = await emitRetry('room:resume', { code: seat.code, playerId: seat.playerId, token: seat.token });
  ui.busy['room:resume'] = false;
  if (res.ok) {
    saveSeat({ ...seat, left: false });   // the server cleared `left` and sends state
    state.away = false;
    ui.notice = null;
  } else if (res.code === 'BAD_SEAT') {
    forgetSeat();
    state.snap = null;
    ui.notice = { title: 'Your seat is gone', text: `Your seat in ${seat.code} moved to another phone, or the host started a new game after you left. Join again with the code if the room is still open.` };
  } else if (res.code === 'NO_ROOM' || res.code === 'BAD_CODE') {
    forgetSeat();
    state.snap = null;
    ui.notice = { title: `Room ${seat.code} has closed`, text: 'Nobody is playing in it any more. Create a room or join another one.' };
  } else {
    showError(res);
  }
  render();
}

async function reclaimSeat() {
  const r = ui.reclaim;
  if (!r) return;
  const res = await emitRetry('room:reclaim', { code: r.code, name: r.name });
  if (res.ok) ui.reclaim = { ...r, stage: 'waiting', requestId: res.requestId };
  else { ui.reclaim = null; showError(res); }
  render();
}

function stepTimer(key, dir) {
  const st = state.snap?.room?.settings || {};
  const t = TIMERS.find((x) => x.key === key);
  if (!t) return;
  let v = (st[key] ?? t.min) + dir * t.step;
  if (key === 'discussionSeconds') v = dir > 0 && (st[key] ?? 0) === 0 ? 30 : v < 30 ? 0 : v;
  const max = key === 'nightMinSeconds' ? Math.min(t.max, st.nightSeconds ?? t.max) : t.max;
  v = clamp(v, t.min, max);
  const patch = { [key]: v };
  if (key === 'nightSeconds' && (st.nightMinSeconds ?? 0) > v) patch.nightMinSeconds = Math.min(60, v);
  settingsPatch(patch);
}

function stepRole(id, dir) {
  const st = state.snap?.room?.settings || {};
  const info = roleInfo(id);
  const roles = { ...(st.roles || {}) };
  let n = (roles[id] || 0) + dir;
  if (id === 'mason') n = dir > 0 ? Math.max(2, n) : n < 2 ? 0 : n;
  roles[id] = clamp(n, 0, info.max ?? 1);
  if (!roles[id]) delete roles[id];
  settingsPatch({ roles });
}

function setSetting(key, value) {
  if (!state.snap?.room?.isHost) return;
  if (key === 'preset') { if (PRESETS[value]) settingsPatch(PRESETS[value].patch); return; }
  const parsed = value === 'true' ? true : value === 'false' ? false : value;
  settingsPatch({ [key]: parsed });
}

function toggleAllowed(id) {
  const st = state.snap?.room?.settings || {};
  const set = new Set(st.allowedRoles || ROLE_ORDER);
  if (set.has(id)) set.delete(id); else set.add(id);
  for (const a of ALWAYS_ALLOWED) set.add(a);
  settingsPatch({ allowedRoles: ROLE_ORDER.filter((x) => set.has(x)) });
}

// One visible pick for everyone (night grid, ghost guess, Hunter's shot).
function pickTile(id, el) {
  if (!state.snap?.game || el?.getAttribute('aria-disabled') === 'true') return;
  ui.pick = ui.pick[0] === id ? [] : [id];
  render();
}

// A ghost's guess for tonight (dead players only; it never affects the game).
async function confirmGhostGuess() {
  const t = state.snap?.game?.night?.task;
  if (!t || !ui.pick[0]) return;
  buzz();
  chime('tap');
  const res = await send('game:night-action', { target: ui.pick[0] });
  if (res.ok) toast('Sent.', 'i-check');
}

async function castVote(target) {
  const v = state.snap?.game?.day?.vote;
  if (!v?.canVote || (v.blocked || []).includes(target) || ui.busy['game:vote']) return;
  ui.pendingVote = target;
  const res = await send('game:vote', { target }, { key: 'game:vote' });
  ui.pendingVote = null;
  if (res.ok) announce(target === 'skip' ? 'You chose to skip.' : `You voted for ${nameOf(target)}.`);
  render();
}

async function leaveRoom() {
  const inGame = !!state.snap?.game;
  const seat = savedSeat();
  const res = await send('room:leave', {});
  if (!res.ok) return;
  ui.sheet = null;
  state.snap = null;
  state.away = false;
  if (inGame && seat) saveSeat({ ...seat, left: true });   // the token stays valid until the game ends
  else forgetSeat();
  // Reconnect without the seat, so this phone stops receiving the game until it rejoins.
  if (socket) socket.disconnect().connect();
  render();
}

async function shareLink() {
  const code = state.snap?.room?.code;
  if (!code) return;
  const url = joinLink(code);
  if (navigator.share) {
    try { await navigator.share({ title: 'Werewolf', text: `Join my Werewolf game. Room code ${code}.`, url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  copyLink();
}

async function copyLink() {
  const code = state.snap?.room?.code;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(joinLink(code));
    toast('Link copied. Paste it into your group chat.', 'i-copy');
  } catch {
    ui.sheet = 'code';
    render();
    toast('Copy the link from the box below the QR code.', 'i-info');
  }
}

function togglePref(key) {
  prefs[key] = !prefs[key];
  savePrefs();
  // This tap is also the gesture iOS needs before speech or sound can play.
  if (key === 'narration' && prefs.narration) narrate('Narration is on.');
  if (key === 'sounds' && prefs.sounds) chime('tap');
  if (key === 'haptics' && prefs.haptics) buzz();
  render();
}

const ACTIONS = {
  create: () => homeSubmit('create'),
  join: () => homeSubmit('join'),
  rejoin: () => rejoin(),
  reclaim: () => reclaimSeat(),
  'reclaim-cancel': () => { ui.reclaim = null; render(); },
  sheet: (el) => { ui.sheet = el.dataset.arg; render(); requestAnimationFrame(() => document.querySelector('[data-testid="sheet-close"]')?.focus()); },
  'close-sheet': () => { ui.sheet = null; render(); },
  ready: () => send('lobby:ready', { ready: !meInRoom()?.ready }),
  setting: (el) => { const [k, ...rest] = el.dataset.arg.split(':'); setSetting(k, rest.join(':')); },
  timer: (el) => { const [k, d] = el.dataset.arg.split(':'); stepTimer(k, Number(d)); },
  'role-count': (el) => { const [id, d] = el.dataset.arg.split(':'); stepRole(id, Number(d)); },
  allow: (el) => toggleAllowed(el.dataset.arg),
  shuffle: () => send('lobby:shuffle', {}),
  'toggle-expand': (el) => { ui.expanded[el.dataset.arg] = !ui.expanded[el.dataset.arg]; render(); },
  share: () => shareLink(),
  'copy-link': () => copyLink(),
  kick: (el) => {
    const id = el.dataset.arg;
    confirmThen({ title: `Remove ${nameOf(id)}?`, text: 'They go back to the home screen and can join again with the code.', yes: 'Remove', tone: 'danger' },
      () => { ui.sheet = null; send('lobby:kick', { playerId: id }); });
  },
  transfer: (el) => {
    const id = el.dataset.arg;
    confirmThen({ title: `Make ${nameOf(id)} the host?`, text: 'They get the host controls and you become a regular player.', yes: 'Make host' },
      () => { ui.sheet = null; send('host:transfer', { playerId: id }); });
  },
  approve: (el) => { const [requestId, yes] = el.dataset.arg.split(':'); send('host:approve-reclaim', { requestId, allow: yes === 'yes' }); },
  seen: () => { buzz(); send('game:seen-role', {}); },
  pick: (el) => pickTile(el.dataset.arg, el),
  confirm: () => (state.snap?.game?.me?.alive ? confirmNight() : confirmGhostGuess()),
  peek: () => setPeek(!ui.peekOpen),
  'priv-wolf': (el) => privateAction({ target: el.dataset.arg }),
  'priv-heal': (el) => { ui.witch = { ...ui.witch, heal: ui.witch.heal === el.dataset.arg ? null : el.dataset.arg }; keepPeekOpen(); render(); },
  'priv-poison': (el) => { ui.witch = { ...ui.witch, poison: ui.witch.poison === el.dataset.arg ? null : el.dataset.arg }; keepPeekOpen(); render(); },
  'priv-witch': (el) => privateAction(el.dataset.arg === 'pass' ? { heal: null, poison: null } : { heal: ui.witch.heal, poison: ui.witch.poison }),
  'priv-cupid': (el) => {
    const id = el.dataset.arg;
    ui.cupid = ui.cupid.includes(id) ? ui.cupid.filter((x) => x !== id) : [...ui.cupid, id].slice(-2);
    keepPeekOpen();
    render();
  },
  'priv-cupid-send': () => { if (ui.cupid.length === 2) privateAction({ targets: ui.cupid.slice(0, 2) }); },
  'priv-doctor-self': async () => {
    const res = await privateAction({ target: state.snap.room.you });
    if (res.ok) { setLocalNightDone(); render(); }
  },
  vote: (el) => { if (el.getAttribute('aria-disabled') !== 'true') castVote(el.dataset.arg); },
  shoot: () => { const target = ui.pick[0]; if (target) { buzz(); send('game:shoot', { target }); } },
  host: (el) => {
    const action = el.dataset.arg;
    const h = HOST[action];
    if (h) confirmThen({ title: h.title, text: h.text, yes: h.yes }, () => send('host:advance', { action }, { key: `host:${action}` }));
  },
  'end-game': () => confirmThen({ title: 'End the game for everyone?', text: 'Everyone goes back to the lobby and nobody wins.', yes: 'End the game', tone: 'danger' },
    () => { ui.sheet = null; send('host:end-game', {}); }),
  'play-again': () => send('host:play-again', {}),
  leave: () => confirmThen(state.snap?.game
    ? { title: 'Leave this game?', text: 'Your seat stays in the game, marked as left. You can rejoin from the home screen until the game ends. If you are the host, host passes to someone else.', yes: 'Leave', tone: 'danger' }
    : { title: 'Leave the room?', text: 'You can join again with the code.', yes: 'Leave', tone: 'danger' }, leaveRoom),
  pref: (el) => togglePref(el.dataset.arg),
  'dialog-yes': () => { const d = ui.dialog; ui.dialog = null; render(); d?.run?.(); },
  'dialog-no': () => { ui.dialog = null; render(); },
  'death-ok': () => { ui.death = null; render(); },
};

/* ---------- Events ---------- */

let lastPointerDown = 0;
let lastPointerUp = 0;
let activeHold = null;
const lastTap = {};

function holdStart(e) {
  const el = e.target.closest('[data-hold]');
  if (!el || (e.pointerType === 'mouse' && e.button !== 0)) return;
  lastPointerDown = performance.now();
  try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  activeHold = { kind: el.dataset.hold, pointerId: e.pointerId, start: performance.now() };
  ui.hold[activeHold.kind] = true;
  render();
}

function holdEnd(e, cancelled = false) {
  if (!activeHold || (e && e.pointerId !== activeHold.pointerId)) return;
  const { kind, start } = activeHold;
  activeHold = null;
  ui.hold[kind] = false;
  const now = performance.now();
  lastPointerUp = now;
  if (!cancelled && now - start < 300 && kind === 'eye') { setPeek(!ui.peekOpen); return; }
  if (!cancelled && now - start < 300) {
    // A quick tap closes a reveal kept open; two quick taps keep it open.
    if (ui.sticky[kind]) { ui.sticky[kind] = false; lastTap[kind] = 0; }
    else if (lastTap[kind] && now - lastTap[kind] < 450) { ui.sticky[kind] = true; lastTap[kind] = 0; }
    else lastTap[kind] = now;
  }
  render();
}

function releaseHolds() {
  activeHold = null;
  ui.hold = {};
  ui.peekOpen = false;
  clearTimeout(peekTimer);
  render();
}

function onClick(e) {
  const holdEl = e.target.closest('[data-hold]');
  if (holdEl) {
    // Keyboard and screen-reader activation arrives as a click with no press or release just before it.
    const t = performance.now();
    if (t - lastPointerDown > 700 && t - lastPointerUp > 300) {
      const k = holdEl.dataset.hold;
      if (k === 'eye') { setPeek(!ui.peekOpen); return; }
      ui.sticky[k] = !ui.sticky[k];
      render();
    }
    return;
  }
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  fn(el, e);
}

function onInput(e) {
  const el = e.target;
  if (el.id === 'name-input') {
    ui.home.name = el.value;
    if (ui.home.errors.name) { ui.home.errors = { ...ui.home.errors, name: null }; render(); }
  } else if (el.id === 'join-code') {
    const v = el.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    if (el.value !== v) el.value = v;
    ui.home.code = v;
    if (ui.home.errors.code) { ui.home.errors = { ...ui.home.errors, code: null }; render(); }
  }
}

function onChange(e) {
  const el = e.target;
  if (el.dataset.change === 'reveal') settingsPatch({ reveal: el.value });
}

function onKeyDown(e) {
  if (e.key === 'Escape') {
    if (ui.dialog) { ui.dialog = null; render(); }
    else if (ui.sheet) { ui.sheet = null; render(); }
    else if (Object.values(ui.sticky).some(Boolean)) { ui.sticky = {}; render(); }
  } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && e.target.matches?.('[role="radio"]')) {
    const radios = Array.from(e.target.closest('[role="radiogroup"]').querySelectorAll('[role="radio"]:not(:disabled)'));
    const i = radios.indexOf(e.target) + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1);
    const next = radios[(i + radios.length) % radios.length];
    if (next) { e.preventDefault(); next.focus(); next.click(); }
  } else if (e.key === 'Enter' && e.target.id === 'join-code') {
    e.preventDefault();
    homeSubmit('join');
  } else if (e.key === 'Enter' && e.target.id === 'name-input') {
    e.preventDefault();
    homeSubmit(ui.home.code.length === 4 ? 'join' : 'create');
  }
}

function bindEvents() {
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('submit', (e) => e.preventDefault());
  document.addEventListener('pointerdown', (e) => {
    requestWakeLock();
    if (e.target.closest?.('.private-panel')) keepPeekOpen();
    holdStart(e);
  });
  document.addEventListener('pointerup', (e) => holdEnd(e));
  document.addEventListener('pointercancel', (e) => holdEnd(e, true));
  document.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-hold]')) e.preventDefault(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      requestWakeLock();
      // iOS closes the socket when the phone locks; connect() alone does nothing while a retry is pending.
      if (socket) socket.disconnect().connect();
    } else {
      releaseHolds();
    }
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted && socket) socket.disconnect().connect(); });
  window.addEventListener('blur', () => { if (activeHold) releaseHolds(); });
}

/* ---------- Mock mode: sample snapshots, no server ---------- */

let mockIndex = null;

function applyUi(overrides) {
  for (const [k, v] of Object.entries(overrides || {})) {
    const cur = ui[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) ui[k] = { ...cur, ...v };
    else ui[k] = v;
  }
}

async function startMock() {
  let mod;
  try {
    mod = await import('./mock/mocks.js');
  } catch (err) {
    ui.notice = { title: 'Mocks did not load', text: String(err && err.message || err) };
    MOCK_FALLBACK();
    return;
  }
  mockIndex = mod.buildMocks({ roles: state.roles, now: Date.now() });
  if (MOCK === 'list') { render(); return; }
  const m = mockIndex[MOCK];
  if (!m) {
    ui.notice = { title: `No mock called “${MOCK}”`, text: 'Open ?mock=list to see every screen.' };
    MOCK_FALLBACK();
    return;
  }
  state.snap = m.snap || null;
  state.away = !!m.away;
  mockSeat = m.seat || null;
  ui.forceBanner = !!m.banner;
  state.restarting = !!m.restarting;
  syncPick();
  ui.screenKey = screenKeyOf();
  if (m.nightDone) mockNightDone = nightKey();
  applyUi(m.ui);
  render();
}

function MOCK_FALLBACK() {
  state.snap = null;
  render();
}

function mockEmit(event, payload) {
  const s = state.snap;
  const g = s?.game;
  const you = s?.room?.you;
  const me = s?.room?.players?.find((p) => p.id === you);
  switch (event) {
    case 'room:create':
    case 'room:join':
      return { ok: false, code: 'NO_ROOM', error: 'Mock mode has no server. Open ?mock=list to choose a screen.' };
    case 'lobby:ready':
      if (me) me.ready = !!payload.ready;
      break;
    case 'lobby:settings':
      if (s) Object.assign(s.room.settings, payload.patch);
      break;
    case 'game:seen-role':
      if (g?.reveal) { g.reveal.youSeen = true; if (!g.reveal.seen.includes(you)) g.reveal.seen.push(you); }
      break;
    case 'game:night-action': {
      const t = g?.night?.task;
      if (t) {
        t.submitted = payload;
        if (t.kind === 'wolf' && t.wolf && payload.target) t.wolf.picks = { ...t.wolf.picks, [you]: payload.target };
        if (t.kind !== 'wolf') t.done = true;
        if ((t.kind === 'seer' || t.kind === 'sorceress') && payload.target) {
          t.result = t.kind === 'seer'
            ? { target: payload.target, wolf: false, text: `${nameOf(payload.target)} is not a werewolf` }
            : { target: payload.target, seer: false, text: `${nameOf(payload.target)} is not the Seer` };
        }
      }
      break;
    }
    case 'game:vote': {
      const v = g?.day?.vote;
      if (v) { v.myVote = payload.target; if (!v.voted.includes(you)) v.voted.push(you); }
      break;
    }
    default:
      break;
  }
  setTimeout(render, 0);
  return { ok: true };
}

function viewMockList() {
  const groups = {};
  for (const [name, m] of Object.entries(mockIndex || {})) (groups[m.group] = groups[m.group] || []).push([name, m.title]);
  return screen('mocks', 'mocks', html`<main class="main" id="main">
    <div class="stack"><h1 class="h2" tabindex="-1">Mock screens</h1><p class="muted">Every screen and state, drawn from sample snapshots with no server. Add ?mock=name to the address to open one.</p></div>
    <div class="mock-list" data-testid="mock-list">${Object.entries(groups).map(([grp, items]) => html`<section class="mock-group" aria-label="${grp}">
      <h2 class="section-title">${grp}</h2>
      <div class="mock-links">${items.map(([n, t]) => html`<a href="?mock=${encodeURIComponent(n)}" data-testid="mock-${n}" data-mock="${n}">${t}</a>`)}</div>
    </section>`)}</div>
  </main>`);
}

/* ---------- Boot ---------- */

function viewResuming() {
  const seat = savedSeat();
  return screen('resuming', 'resuming', html`<main class="main boot" id="main">
    <svg class="boot-mark" aria-hidden="true"><use href="#i-mark"></use></svg>
    <h1 class="h3" tabindex="-1">Rejoining ${seat?.code || 'your room'}</h1>
    <p class="boot-text">Finding your seat${seat?.name ? ` as ${seat.name}` : ''}…</p>
  </main>`);
}

async function boot() {
  const room = params.get('room');
  if (room) ui.home.code = room.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  bindEvents();
  await Promise.race([loadRoles(), new Promise((r) => setTimeout(r, 3000))]);
  booted = true;
  setInterval(tick, 250);
  if (MOCK) { await startMock(); return; }
  if (handshakeSeat()) {
    ui.resuming = true;
    setTimeout(() => { if (ui.resuming) { ui.resuming = false; render(); } }, 5000);
  }
  render();
  connect();
}

boot();
