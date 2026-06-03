import type { VercelRequest, VercelResponse } from '@vercel/node';
import { setWebhook } from '../lib/telegram';

// GET /api/setup-webhook?url=https://your-deployment.vercel.app/api/webhook
// Call this once after deploying to register the webhook with Telegram.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const webhookUrl = req.query.url as string;
  if (!webhookUrl) return res.status(400).send('Missing ?url= param');

  const result = await setWebhook(webhookUrl);
  return res.status(200).send(result);
}
