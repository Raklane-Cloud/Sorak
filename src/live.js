const { pool } = require('./db');
const { publicState } = require('./state');

// Live updates over Server-Sent Events, safe to run on many replicas.
//
// A viewer is connected to one replica, but a vote may land on any other.
// Every write bumps sessions.version; each replica checks the versions of
// the sessions its own viewers are watching once a second and, when one
// moved, rebuilds that session's state once and pushes it to all of them.
// That costs one small query per replica per second, works through a
// transaction-mode connection pooler, and needs no Redis or message bus.

const POLL_MS = Number(process.env.LIVE_POLL_MS || 1000);
const HEARTBEAT_MS = 20000;
const NUDGE_MS = 150;

const viewers = new Map(); // code -> Set<res>
const seen = new Map(); // code -> last version broadcast
const nudged = new Map(); // code -> pending refresh timer

function send(res, data) {
  res.write(`data: ${data}\n\n`);
}

async function refresh(code) {
  const set = viewers.get(code);
  if (!set || set.size === 0) return;
  const state = await publicState(code);
  if (!state) return;
  seen.set(code, state.version);
  const data = JSON.stringify(state);
  for (const res of set) send(res, data);
}

async function subscribe(code, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // If this replica goes away (deploy, scale-down) the browser reconnects
  // to another one after this many milliseconds.
  res.write('retry: 2000\n\n');

  if (!viewers.has(code)) viewers.set(code, new Set());
  viewers.get(code).add(res);

  req.on('close', () => {
    const set = viewers.get(code);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) {
      viewers.delete(code);
      seen.delete(code);
    }
  });

  const state = await publicState(code);
  if (state) send(res, JSON.stringify(state));
}

// Called after a write on this replica so its own viewers update right away
// instead of waiting for the next tick. Bursts of votes collapse into one
// refresh.
function nudge(code) {
  if (nudged.has(code)) return;
  nudged.set(
    code,
    setTimeout(() => {
      nudged.delete(code);
      refresh(code).catch((err) => console.error('live refresh failed:', err.message));
    }, NUDGE_MS),
  );
}

let ticking = false;
async function tick() {
  if (ticking || viewers.size === 0) return;
  ticking = true;
  try {
    const { rows } = await pool.query(
      'SELECT code, version FROM sessions WHERE code = ANY($1)',
      [[...viewers.keys()]],
    );
    await Promise.all(
      rows
        .filter((r) => seen.get(r.code) !== String(r.version))
        .map((r) => refresh(r.code)),
    );
  } catch (err) {
    console.error('live tick failed:', err.message);
  } finally {
    ticking = false;
  }
}

const tickTimer = setInterval(tick, POLL_MS);
const heartbeatTimer = setInterval(() => {
  for (const set of viewers.values()) for (const res of set) res.write(': ping\n\n');
}, HEARTBEAT_MS);

function viewerCount() {
  let n = 0;
  for (const set of viewers.values()) n += set.size;
  return n;
}

// On shutdown, end every stream so browsers reconnect to a replica that is
// staying up.
function closeAll() {
  clearInterval(tickTimer);
  clearInterval(heartbeatTimer);
  for (const t of nudged.values()) clearTimeout(t);
  for (const set of viewers.values()) for (const res of set) res.end();
  viewers.clear();
}

module.exports = { subscribe, nudge, closeAll, viewerCount };
