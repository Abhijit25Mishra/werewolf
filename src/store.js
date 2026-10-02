'use strict';
// A small key-value store for room snapshots, leases and the deploy marker (docs/PROTOCOL.md,
// "Surviving restarts"). Values are strings. Every driver has the same interface:
//   get(key)                          -> string | null
//   set(key, value, { ttlMs, nx })    -> true when written (with nx, only if the key was absent)
//   del(key)
//   delIfEquals(key, value)           -> true when the key held exactly `value` and was deleted
//   close()
// plus `kind` ('memory' | 'file' | 'redis') and `durable` (whether games survive a restart).
// Drivers throw on I/O failure; callers decide whether that means "retry" or "log and move on".
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DIR = path.join(__dirname, '..', '.data');

function expiryOf(ttlMs) {
  return Number.isFinite(ttlMs) && ttlMs > 0 ? Date.now() + Math.ceil(ttlMs) : null;
}

// In-process store. One object can be shared by several createServer instances (tests).
// `durable` says whether to treat it as surviving a restart; a private store that dies with
// its server is not.
function createMemoryStore({ durable = true } = {}) {
  const data = new Map(); // key -> { value, expiresAt }
  const live = (key) => {
    const entry = data.get(key);
    if (!entry) return null;
    if (entry.expiresAt != null && entry.expiresAt <= Date.now()) {
      data.delete(key);
      return null;
    }
    return entry;
  };
  return {
    kind: 'memory',
    durable,
    data,
    async get(key) {
      const entry = live(key);
      return entry ? entry.value : null;
    },
    async set(key, value, { ttlMs, nx } = {}) {
      if (nx && live(key)) return false;
      data.set(key, { value: String(value), expiresAt: expiryOf(ttlMs) });
      return true;
    },
    async del(key) {
      data.delete(key);
    },
    async delIfEquals(key, value) {
      const entry = live(key);
      if (!entry || entry.value !== String(value)) return false;
      data.delete(key);
      return true;
    },
    async close() {},
  };
}

async function unlinkQuiet(file) {
  try {
    await fsp.unlink(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

// One JSON file per key, { value, expiresAt }, in STORE_DIR or .data/ in the repo. Writes go to
// a temp file first and then rename into place, so a reader never sees half a file; NX creates
// the key with link(), which fails if it already exists.
function createFileStore({ dir = process.env.STORE_DIR || DEFAULT_DIR } = {}) {
  let made = null;
  const ensureDir = () => (made = made || fsp.mkdir(dir, { recursive: true }).catch((e) => { made = null; throw e; }));
  const fileOf = (key) => path.join(dir, `${encodeURIComponent(key)}.json`);

  async function readEntry(key) {
    let text;
    try {
      text = await fsp.readFile(fileOf(key), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    let entry = null;
    try {
      entry = JSON.parse(text);
    } catch (e) {
      entry = null;
    }
    if (!entry || typeof entry.value !== 'string') return { broken: true };
    if (entry.expiresAt != null && entry.expiresAt <= Date.now()) return { expired: true };
    return entry;
  }

  async function writeTemp(key, value, ttlMs) {
    await ensureDir();
    const tmp = path.join(dir, `.${encodeURIComponent(key)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    await fsp.writeFile(tmp, JSON.stringify({ value, expiresAt: expiryOf(ttlMs) }));
    return tmp;
  }

  // Creates `file` from `tmp` only if `file` doesn't exist yet.
  async function createExclusive(tmp, file) {
    try {
      await fsp.link(tmp, file);
      return true;
    } catch (e) {
      if (e.code === 'EEXIST') return false;
      if (!['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes(e.code)) throw e;
    }
    // Filesystems without hard links: exclusive create, then write.
    try {
      await fsp.writeFile(file, await fsp.readFile(tmp), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code === 'EEXIST') return false;
      throw e;
    }
  }

  return {
    kind: 'file',
    durable: true,
    dir,
    async get(key) {
      const entry = await readEntry(key);
      if (!entry) return null;
      if (entry.expired || entry.broken) {
        await unlinkQuiet(fileOf(key)).catch(() => {});
        return null;
      }
      return entry.value;
    },
    async set(key, value, { ttlMs, nx } = {}) {
      const file = fileOf(key);
      const tmp = await writeTemp(key, String(value), ttlMs);
      try {
        if (!nx) {
          await fsp.rename(tmp, file);
          return true;
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          if (await createExclusive(tmp, file)) return true;
          const entry = await readEntry(key);
          if (entry && !entry.expired && !entry.broken) return false; // a live value: NX fails
          if (entry) await unlinkQuiet(file); // expired or unreadable: clear it and try again
        }
        return false;
      } finally {
        await unlinkQuiet(tmp).catch(() => {});
      }
    },
    async del(key) {
      await unlinkQuiet(fileOf(key));
    },
    async delIfEquals(key, value) {
      const entry = await readEntry(key);
      if (!entry || entry.expired || entry.broken || entry.value !== String(value)) return false;
      await unlinkQuiet(fileOf(key));
      return true;
    },
    async close() {},
  };
}

const DEL_IF_EQUALS = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

// Render Key Value (or any Redis). Reconnects on its own with backoff; while the connection is
// down, commands fail fast instead of queueing, and each one gives up after `timeoutMs`.
// Connection errors are logged (at most every 30 s) and never crash the process.
function createRedisStore({ url = process.env.REDIS_URL, prefix = '', timeoutMs = 3000, log = console } = {}) {
  const { createClient } = require('redis');
  let lastLog = 0;
  let suppressed = 0;
  const report = (what, e) => {
    const t = Date.now();
    if (t - lastLog < 30000) {
      suppressed += 1;
      return;
    }
    lastLog = t;
    log.warn(`[store] redis ${what}: ${e && e.message ? e.message : e}${suppressed ? ` (${suppressed} more since the last report)` : ''}`);
    suppressed = 0;
  };
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: (retries) => Math.min(200 * 2 ** Math.min(retries, 5), 5000),
    },
  });
  let closing = false;
  client.on('error', (e) => report('error', e));
  client.on('ready', () => {
    if (lastLog) log.log('[store] redis connection is back');
  });
  client.connect().catch((e) => report('connect failed', e));

  const k = (key) => prefix + key;
  function timed(promise) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`redis did not answer within ${timeoutMs} ms`)), timeoutMs);
      timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  return {
    kind: 'redis',
    durable: true,
    client,
    async get(key) {
      const value = await timed(client.get(k(key)));
      return value == null ? null : String(value);
    },
    async set(key, value, { ttlMs, nx } = {}) {
      const options = {};
      if (Number.isFinite(ttlMs) && ttlMs > 0) options.expiration = { type: 'PX', value: Math.ceil(ttlMs) };
      if (nx) options.condition = 'NX';
      const reply = await timed(client.set(k(key), String(value), options));
      return reply === 'OK' || (reply != null && String(reply) === 'OK');
    },
    async del(key) {
      await timed(client.del(k(key)));
    },
    async delIfEquals(key, value) {
      const reply = await timed(client.eval(DEL_IF_EQUALS, { keys: [k(key)], arguments: [String(value)] }));
      return Number(reply) === 1;
    },
    async close() {
      if (closing) return;
      closing = true;
      try {
        await timed(client.close());
      } catch (e) {
        try { client.destroy(); } catch (err) { /* already closed */ }
      }
    },
  };
}

// The production choice: Redis when REDIS_URL is set, else the file store.
function createDefaultStore({ url = process.env.REDIS_URL, dir } = {}) {
  if (url) return createRedisStore({ url });
  return createFileStore(dir ? { dir } : {});
}

module.exports = { createMemoryStore, createFileStore, createRedisStore, createDefaultStore, DEFAULT_DIR };
