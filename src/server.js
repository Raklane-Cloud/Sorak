const path = require('node:path');
const express = require('express');
const { pool, migrate } = require('./db');
const live = require('./live');
const api = require('./api');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.set('trust proxy', true); // behind Raklane's ingress, which sets X-Forwarded-*
app.disable('x-powered-by');

let shuttingDown = false;

// Raklane health-checks new replicas before sending them traffic. Fail the
// check while draining so no new requests are routed here.
app.get('/healthz', async (req, res) => {
  if (shuttingDown) return res.status(503).json({ ok: false, reason: 'shutting down' });
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, viewers: live.viewerCount() });
  } catch {
    res.status(503).json({ ok: false, reason: 'database unreachable' });
  }
});

app.use('/api', express.json({ limit: '16kb' }), api);

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '5m' }));
const page = (name) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, `${name}.html`));
app.get('/s/:code', page('audience'));
app.get('/s/:code/host', page('host'));
app.get('/s/:code/present', page('present'));
app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html')));

// The database may still be starting (or briefly unreachable) when a
// replica boots, so retry for a while before giving up.
async function migrateWithRetry(attempts = 15) {
  for (let i = 1; ; i++) {
    try {
      return await migrate();
    } catch (err) {
      if (i >= attempts) throw err;
      console.warn(`database not ready (${err.message}), retrying in 2s [${i}/${attempts}]`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  await migrateWithRetry();
  const server = app.listen(PORT, () => console.log(`sorak listening on :${PORT}`));

  // Zero-downtime deploys and scale-downs send SIGTERM to the old replica.
  // Close live streams (browsers reconnect elsewhere), let in-flight
  // requests finish, then exit.
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, draining`);
    live.closeAll();
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('failed to start:', err);
  process.exit(1);
});
