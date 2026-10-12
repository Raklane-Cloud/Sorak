const { pool } = require('./db');

// Options with their vote counts, grouped by poll id.
async function loadOptions(pollIds) {
  const byPoll = new Map(pollIds.map((id) => [String(id), []]));
  if (pollIds.length === 0) return byPoll;
  const { rows } = await pool.query(
    `SELECT o.id, o.poll_id, o.label, count(v.voter_id)::int AS votes
       FROM poll_options o
       LEFT JOIN votes v ON v.option_id = o.id
      WHERE o.poll_id = ANY($1)
      GROUP BY o.id
      ORDER BY o.poll_id, o.position`,
    [pollIds],
  );
  for (const r of rows) {
    byPoll.get(String(r.poll_id)).push({ id: String(r.id), label: r.label, votes: r.votes });
  }
  return byPoll;
}

function toPoll(row, options) {
  return {
    id: String(row.id),
    question: row.question,
    closed: row.closed,
    options,
    total: options.reduce((sum, o) => sum + o.votes, 0),
  };
}

async function loadQuestions(code, { includeHidden }) {
  const { rows } = await pool.query(
    `SELECT q.id, q.body, q.author, q.answered, q.hidden, q.created_at,
            count(qv.voter_id)::int AS votes
       FROM questions q
       LEFT JOIN question_votes qv ON qv.question_id = q.id
      WHERE q.session_code = $1 AND ($2 OR NOT q.hidden)
      GROUP BY q.id
      ORDER BY q.answered, votes DESC, q.created_at
      LIMIT 300`,
    [code, includeHidden],
  );
  return rows.map((q) => ({
    id: String(q.id),
    body: q.body,
    author: q.author,
    answered: q.answered,
    hidden: q.hidden,
    votes: q.votes,
    createdAt: q.created_at,
  }));
}

async function loadSession(code) {
  const { rows } = await pool.query(
    'SELECT code, title, version, active_poll_id FROM sessions WHERE code = $1',
    [code],
  );
  return rows[0] || null;
}

// What the audience and the presenter screen see. Built once per change per
// replica and broadcast to every viewer on that replica.
async function publicState(code) {
  const session = await loadSession(code);
  if (!session) return null;

  let activePoll = null;
  if (session.active_poll_id) {
    const { rows } = await pool.query(
      'SELECT id, question, closed FROM polls WHERE id = $1',
      [session.active_poll_id],
    );
    if (rows[0]) {
      const options = await loadOptions([rows[0].id]);
      activePoll = toPoll(rows[0], options.get(String(rows[0].id)));
    }
  }

  return {
    code: session.code,
    title: session.title,
    version: String(session.version),
    activePoll,
    questions: await loadQuestions(code, { includeHidden: false }),
  };
}

// Everything, for the host's control panel.
async function hostState(code) {
  const session = await loadSession(code);
  if (!session) return null;

  const { rows: polls } = await pool.query(
    'SELECT id, question, closed FROM polls WHERE session_code = $1 ORDER BY created_at',
    [code],
  );
  const options = await loadOptions(polls.map((p) => p.id));

  return {
    code: session.code,
    title: session.title,
    version: String(session.version),
    activePollId: session.active_poll_id ? String(session.active_poll_id) : null,
    polls: polls.map((p) => toPoll(p, options.get(String(p.id)))),
    questions: await loadQuestions(code, { includeHidden: true }),
  };
}

module.exports = { publicState, hostState };
