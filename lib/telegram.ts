const TG_BASE = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}`;

async function post(method: string, body: object): Promise<void> {
  const res = await fetch(`${TG_BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error(`[tg:${method}]`, await res.text());
}

export async function sendMessage(chatId: number, text: string): Promise<void> {
  await post('sendMessage', { chat_id: chatId, text });
}

// rows: each inner array is one row of buttons
export async function sendInlineKeyboard(
  chatId: number,
  text: string,
  rows: string[][]
): Promise<void> {
  await post('sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: rows.map((row) =>
        row.map((label) => ({ text: label, callback_data: label }))
      ),
    },
  });
}

export async function answerCallback(callbackQueryId: string): Promise<void> {
  await post('answerCallbackQuery', { callback_query_id: callbackQueryId });
}

export async function setWebhook(webhookUrl: string): Promise<string> {
  await fetch(`${TG_BASE}/deleteWebhook`);
  const res = await fetch(`${TG_BASE}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
  return res.text();
}
