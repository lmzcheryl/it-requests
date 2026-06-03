import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleUpdate } from '../lib/bot';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    await handleUpdate(req.body);
  } catch (err) {
    console.error('[webhook]', err);
  }

  return res.status(200).send('ok');
}
