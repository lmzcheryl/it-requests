import http from 'http';
import { Pool } from 'pg';
import { handleUpdate, checkReminders } from './lib/bot';
import { setWebhook } from './lib/telegram';

const PORT = process.env.PORT || 3000;

const SETUP_SQL = `
CREATE TABLE IF NOT EXISTS requests (
  id             BIGSERIAL PRIMARY KEY,
  requestor      TEXT        NOT NULL,
  request_text   TEXT        NOT NULL,
  priority       TEXT,
  complexity     TEXT,
  status         TEXT        NOT NULL DEFAULT 'New',
  remarks        TEXT,
  requested_date DATE        NOT NULL DEFAULT CURRENT_DATE,
  completed_date TIMESTAMPTZ,
  reminded_at    TIMESTAMPTZ,
  chat_id        BIGINT      NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_state (
  chat_id     BIGINT PRIMARY KEY,
  state_json  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS signal_logs (
  id               BIGSERIAL PRIMARY KEY,
  date_logged      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  what_happened    TEXT        NOT NULL,
  logged_by        TEXT        NOT NULL,
  request_id       BIGINT      REFERENCES requests(id),
  signal_type      TEXT,
  impact           TEXT,
  temporary_fix    TEXT,
  root_cause_guess TEXT,
  kaizen_ideas     TEXT,
  resolved         TEXT,
  chat_id          BIGINT      NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE requests ADD COLUMN reminded_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost`);

  if (req.method === 'GET' && url.pathname === '/setup-webhook') {
    const webhookUrl = url.searchParams.get('url');
    if (!webhookUrl) { res.writeHead(400).end('Missing ?url= param'); return; }
    const result = await setWebhook(webhookUrl);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(result);
    return;
  }

  // GET /setup-db — creates all tables (run once after deploy)
  if (req.method === 'GET' && url.pathname === '/setup-db') {
    if (!process.env.DATABASE_URL) {
      res.writeHead(500).end('DATABASE_URL env var not set');
      return;
    }
    try {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await pool.query(SETUP_SQL);
      await pool.end();
      res.writeHead(200).end('✅ All tables created successfully');
    } catch (err: any) {
      console.error('[setup-db]', err);
      res.writeHead(500).end(`❌ Error: ${err.message}`);
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/webhook') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try { await handleUpdate(JSON.parse(body)); }
      catch (err) { console.error('[webhook]', err); }
      res.writeHead(200).end('ok');
    });
    return;
  }

  res.writeHead(200).end('ok');
});

server.listen(PORT, () => console.log(`Bot server running on port ${PORT}`));

setInterval(() => {
  checkReminders().catch((err) => console.error('[reminders]', err));
}, 30 * 60 * 1000);
