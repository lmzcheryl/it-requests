import http from 'http';
import { handleUpdate, checkReminders } from './lib/bot';
import { setWebhook } from './lib/telegram';

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost`);

  // GET /setup-webhook?url=https://your-app.railway.app/webhook
  if (req.method === 'GET' && url.pathname === '/setup-webhook') {
    const webhookUrl = url.searchParams.get('url');
    if (!webhookUrl) {
      res.writeHead(400).end('Missing ?url= param');
      return;
    }
    const result = await setWebhook(webhookUrl);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(result);
    return;
  }

  // POST /webhook  ← Telegram sends updates here
  if (req.method === 'POST' && url.pathname === '/webhook') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        await handleUpdate(JSON.parse(body));
      } catch (err) {
        console.error('[webhook]', err);
      }
      res.writeHead(200).end('ok');
    });
    return;
  }

  res.writeHead(200).end('ok');
});

server.listen(PORT, () => {
  console.log(`Bot server running on port ${PORT}`);
});

// Check for overdue requests every 30 minutes
setInterval(() => {
  checkReminders().catch((err) => console.error('[reminders]', err));
}, 30 * 60 * 1000);
