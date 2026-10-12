const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const { pool } = require('./db');
const { publicState, hostState } = require('./state');
const live = require('./live');

const router = express.Router();

// Express 5 leaves req.body undefined when a request has no JSON body.
router.use((req, res, next) => {
  req.body ??= {};
  next();
});

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
function newCode() {
  const bytes = crypto.randomBytes(6);
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

function text(value, field, max, { required = true } = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s && required) throw new HttpError(400, `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return s || null;
}

function id(value) {
  if (!/^\d{1,18}$/.test(String(value))) throw new HttpError(400, 'invalid id');
  return String(value);
}

// Anonymous per-browser id, generated client side. Good enough to stop
// casual double voting; not a security boundary.
function voterId(req) {
  const v = req.get('x-voter-id') || '';
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(v)) throw new HttpError(400, 'missing voter id');
  return v;
}

function code(req) {
  const c = String(req.params.code || '').toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(c)) throw new HttpError(404, 'session not found');
  return c;
}

async function requireHost(req) {
  const c = code(req);
  const key = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const { rows } = await pool.query('SELECT host_key_hash FROM sessions WHERE code = $1', [c]);
  if (!rows[0]) throw new HttpError(404, 'session not found');
  const expected = Buffer.from(rows[0].host_key_hash);
  const actual = Buffer.from(hash(key));
  if (!key || !crypto.timingSafeEqual(expected, actual)) throw new HttpError(403, 'not the host');
  return c;
}

// Small per-replica limiter for things people type. With N replicas the
// effective limit is up to N times higher, which is fine for spam control.
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const n = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, n);
    if (n > max) return next(new HttpError(429, 'slow down a little'));
    next();
  };
}

async function bump(c) {
  await pool.query('UPDATE sessions SET version = version + 1 WHERE code = $1', [c]);
  live.nudge(c);
}

function joinUrl(req, c) {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/s/${c}`;
}

// ---------- sessions ----------

router.post('/sessions', rateLimit({ windowMs: 60_000, max: 10 }), async (req, res) => {
  const title = text(req.body.title, 'title', 120);
  const hostKey = crypto.randomBytes(24).toString('base64url');
  for (let attempt = 0; attempt < 5; attempt++) {
    const c = newCode();
    const { rowCount } = await pool.query(
      `INSERT INTO sessions (code, title, host_key_hash) VALUES ($1, $2, $3)
       ON CONFLICT (code) DO NOTHING`,
      [c, title, hash(hostKey)],
    );
    if (rowCount === 1) return res.status(201).json({ code: c, hostKey });
  }
  throw new HttpError(503, 'could not allocate a session code, try again');
});

router.get('/sessions/:code', async (req, res) => {
  const state = await publicState(code(req));
  if (!state) throw new HttpError(404, 'session not found');
  res.json(state);
});

router.get('/sessions/:code/events', async (req, res) => {
  const c = code(req);
  const { rowCount } = await pool.query('SELECT 1 FROM sessions WHERE code = $1', [c]);
  if (!rowCount) throw new HttpError(404, 'session not found');
  await live.subscribe(c, req, res);
});

router.get('/sessions/:code/qr.svg', async (req, res) => {
  const svg = await QRCode.toString(joinUrl(req, code(req)), { type: 'svg', margin: 1 });
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
});

// ---------- audience ----------

router.post('/sessions/:code/polls/:pollId/vote', async (req, res) => {
  const c = code(req);
  const pollId = id(req.params.pollId);
  const optionId = id(req.body.optionId);
  const voter = voterId(req);

  // Insert-or-change the vote and bump the session version in one round
  // trip. Only counts when the option belongs to this open poll in this
  // session.
  const { rowCount } = await pool.query(
    `WITH v AS (
       INSERT INTO votes (poll_id, voter_id, option_id)
       SELECT p.id, $3, o.id
         FROM polls p JOIN poll_options o ON o.poll_id = p.id
        WHERE p.id = $1 AND o.id = $2 AND p.session_code = $4 AND NOT p.closed
       ON CONFLICT (poll_id, voter_id) DO UPDATE SET option_id = EXCLUDED.option_id
       RETURNING 1
     )
     UPDATE sessions SET version = version + 1
      WHERE code = $4 AND EXISTS (SELECT 1 FROM v)`,
    [pollId, optionId, voter, c],
  );
  if (!rowCount) throw new HttpError(409, 'voting on this poll is closed');
  live.nudge(c);
  res.json({ ok: true });
});

router.post(
  '/sessions/:code/questions',
  rateLimit({ windowMs: 60_000, max: 8 }),
  async (req, res) => {
    const c = code(req);
    const body = text(req.body.body, 'question', 280);
    const author = text(req.body.author, 'name', 40, { required: false });
    const { rows } = await pool.query(
      `INSERT INTO questions (session_code, body, author)
       SELECT code, $2, $3 FROM sessions WHERE code = $1
       RETURNING id`,
      [c, body, author],
    );
    if (!rows[0]) throw new HttpError(404, 'session not found');
    await bump(c);
    res.status(201).json({ id: String(rows[0].id) });
  },
);

// Toggles the caller's upvote.
router.post('/sessions/:code/questions/:id/upvote', async (req, res) => {
  const c = code(req);
  const qid = id(req.params.id);
  const voter = voterId(req);

  const { rows } = await pool.query(
    'SELECT 1 FROM questions WHERE id = $1 AND session_code = $2 AND NOT hidden',
    [qid, c],
  );
  if (!rows[0]) throw new HttpError(404, 'question not found');

  const removed = await pool.query(
    'DELETE FROM question_votes WHERE question_id = $1 AND voter_id = $2',
    [qid, voter],
  );
  let upvoted = false;
  if (!removed.rowCount) {
    await pool.query(
      'INSERT INTO question_votes (question_id, voter_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [qid, voter],
    );
    upvoted = true;
  }
  await bump(c);
  res.json({ upvoted });
});

// ---------- host ----------

router.get('/sessions/:code/host', async (req, res) => {
  res.json(await hostState(await requireHost(req)));
});

router.post('/sessions/:code/polls', async (req, res) => {
  const c = await requireHost(req);
  const question = text(req.body.question, 'question', 200);
  const labels = (Array.isArray(req.body.options) ? req.body.options : [])
    .map((o) => text(o, 'option', 80, { required: false }))
    .filter(Boolean);
  if (labels.length < 2) throw new HttpError(400, 'a poll needs at least two options');
  if (labels.length > 10) throw new HttpError(400, 'a poll can have at most ten options');

  const client = await pool.connect();
  let pollId;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO polls (session_code, question) VALUES ($1, $2) RETURNING id',
      [c, question],
    );
    pollId = rows[0].id;
    await client.query(
      `INSERT INTO poll_options (poll_id, label, position)
       SELECT $1, label, ord FROM unnest($2::text[]) WITH ORDINALITY AS t(label, ord)`,
      [pollId, labels],
    );
    if (req.body.activate) {
      await client.query('UPDATE sessions SET active_poll_id = $1 WHERE code = $2', [pollId, c]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await bump(c);
  res.status(201).json({ id: String(pollId) });
});

router.post('/sessions/:code/polls/:pollId/activate', async (req, res) => {
  const c = await requireHost(req);
  const { rowCount } = await pool.query(
    `UPDATE sessions SET active_poll_id = p.id
       FROM polls p WHERE p.id = $1 AND p.session_code = $2 AND sessions.code = $2`,
    [id(req.params.pollId), c],
  );
  if (!rowCount) throw new HttpError(404, 'poll not found');
  await bump(c);
  res.json({ ok: true });
});

router.post('/sessions/:code/deactivate', async (req, res) => {
  const c = await requireHost(req);
  await pool.query('UPDATE sessions SET active_poll_id = NULL WHERE code = $1', [c]);
  await bump(c);
  res.json({ ok: true });
});

router.post('/sessions/:code/polls/:pollId/closed', async (req, res) => {
  const c = await requireHost(req);
  const { rowCount } = await pool.query(
    'UPDATE polls SET closed = $3 WHERE id = $1 AND session_code = $2',
    [id(req.params.pollId), c, Boolean(req.body.closed)],
  );
  if (!rowCount) throw new HttpError(404, 'poll not found');
  await bump(c);
  res.json({ ok: true });
});

router.delete('/sessions/:code/polls/:pollId', async (req, res) => {
  const c = await requireHost(req);
  const pollId = id(req.params.pollId);
  await pool.query(
    'UPDATE sessions SET active_poll_id = NULL WHERE code = $1 AND active_poll_id = $2',
    [c, pollId],
  );
  await pool.query('DELETE FROM polls WHERE id = $1 AND session_code = $2', [pollId, c]);
  await bump(c);
  res.json({ ok: true });
});

router.patch('/sessions/:code/questions/:id', async (req, res) => {
  const c = await requireHost(req);
  const { answered, hidden } = req.body;
  const { rowCount } = await pool.query(
    `UPDATE questions
        SET answered = coalesce($3, answered), hidden = coalesce($4, hidden)
      WHERE id = $1 AND session_code = $2`,
    [
      id(req.params.id),
      c,
      typeof answered === 'boolean' ? answered : null,
      typeof hidden === 'boolean' ? hidden : null,
    ],
  );
  if (!rowCount) throw new HttpError(404, 'question not found');
  await bump(c);
  res.json({ ok: true });
});

// ---------- errors ----------

router.use((req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (res.headersSent) return res.end();
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'something went wrong' });
});

module.exports = router;
