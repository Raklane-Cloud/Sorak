# Sorak — live polls & Q&A

Free live polls and audience Q&A for talks, classes and meetings. The host
creates a session; the audience joins with a 6-letter code or by scanning a
QR code — no app, no sign-up.

- **Live polls** — results move on every phone and on the big screen as votes come in
- **Upvoted Q&A** — the best questions rise to the top; the host marks them answered or hides them
- **Presenter screen** — full-screen view with the join QR code

Built with Node.js, Express and PostgreSQL. No build step, no Redis.

## Deploy on Raklane

1. **Create a database.** In Raklane, add a managed **Postgres** database and copy its connection URL.
2. **Create an app** from this repo (GitHub) or upload this folder as an archive. Raklane detects Node.js on its own — no Dockerfile needed.
3. **Set env vars** in the app's *Env Vars* tab:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the URL from step 1 |

4. **Use `/healthz` as the HTTP health check path** (recommended — it also checks the database; the default `/` works too).
5. **Deploy.** Tables are created on first boot. Open `https://<your-app>.apps.raklane.com`.

That's it. Optional settings:

| Name | Default | What it does |
|---|---|---|
| `PG_POOL_MAX` | `10` | DB connections per replica |
| `DATABASE_SSL` | off | `true` to connect over TLS without verifying the cert |
| `PUBLIC_URL` | request host | base URL put in the QR code (set it if you use a custom domain behind another proxy) |
| `LIVE_POLL_MS` | `1000` | how often each replica checks for changes |

## Why it runs well on Raklane

Sorak is built to scale out, so you can turn on autoscaling and let a room of
500 people hit it at once.

- **Stateless replicas.** Everything lives in Postgres. Any replica can serve any request.
- **Live updates across replicas.** Each change bumps a version number on the session. Every replica checks the versions of the sessions its viewers are watching once a second, and pushes the new state to them over Server-Sent Events. One small query per replica per second — and it works through Raklane's PgBouncer (transaction mode), which rules out `LISTEN/NOTIFY`.
- **Zero-downtime deploys.** On `SIGTERM` a replica fails its health check, closes its live streams and finishes in-flight requests. Browsers reconnect to a new replica within ~2 seconds, so you can ship a change in the middle of a talk.
- **Safe concurrent boots.** Replicas that start together take turns creating the schema (a transaction-scoped advisory lock).

## Run locally

```sh
npm install
echo 'DATABASE_URL=postgres://postgres:postgres@localhost:5432/sorak' > .env
npm run dev
```

Open http://localhost:3000.

## Project layout

```
src/server.js   Express app, health check, graceful shutdown
src/api.js      REST API (sessions, polls, votes, questions)
src/live.js     Server-Sent Events hub that works across replicas
src/state.js    Queries that build what each screen shows
src/db.js       Connection pool and schema
public/         Plain HTML/CSS/JS pages: landing, audience, host, presenter
```

## Notes

- Voters are anonymous: each browser gets a random id that allows one vote per poll and one upvote per question. It stops casual double voting, not a determined attacker.
- The host key is shown once, in the host link (`/s/CODE/host#key=…`). Keep it private; anyone with it can moderate the session.
