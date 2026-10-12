const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it in your app\'s Env Vars tab.');
  process.exit(1);
}

// Raklane's managed Postgres sits behind PgBouncer in transaction mode, so
// this app never relies on session state (no LISTEN, no session-level
// advisory locks, no named prepared statements).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => console.error('postgres pool error:', err.message));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  code           text PRIMARY KEY,
  title          text NOT NULL,
  host_key_hash  text NOT NULL,
  version        bigint NOT NULL DEFAULT 0,
  active_poll_id bigint,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS polls (
  id           bigserial PRIMARY KEY,
  session_code text NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
  question     text NOT NULL,
  closed       boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS polls_session_idx ON polls(session_code);

CREATE TABLE IF NOT EXISTS poll_options (
  id       bigserial PRIMARY KEY,
  poll_id  bigint NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label    text NOT NULL,
  position int NOT NULL
);
CREATE INDEX IF NOT EXISTS poll_options_poll_idx ON poll_options(poll_id);

CREATE TABLE IF NOT EXISTS votes (
  poll_id    bigint NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  voter_id   text NOT NULL,
  option_id  bigint NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, voter_id)
);

CREATE TABLE IF NOT EXISTS questions (
  id           bigserial PRIMARY KEY,
  session_code text NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
  body         text NOT NULL,
  author       text,
  answered     boolean NOT NULL DEFAULT false,
  hidden       boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS questions_session_idx ON questions(session_code);

CREATE TABLE IF NOT EXISTS question_votes (
  question_id bigint NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  voter_id    text NOT NULL,
  PRIMARY KEY (question_id, voter_id)
);
`;

// Every replica runs this on boot. The transaction-scoped advisory lock
// makes replicas that start together take turns instead of racing on
// CREATE TABLE.
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(727274)');
    await client.query(SCHEMA);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, migrate };
