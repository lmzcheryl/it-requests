const TG_BASE = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}`;

async function post(method: string, body: object): Promise<void> {
  await fetch(`${TG_BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function sendMessage(chatId: number, text: string): Promise<void> {
  await post('sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: { remove_keyboard: true },
  });
}

export async function sendKeyboard(
  chatId: number,
  text: string,
  buttons: string[]
): Promise<void> {
  await post('sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: {
      keyboard: buttons.map((b) => [{ text: b }]),
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

export async function setWebhook(webhookUrl: string): Promise<string> {
  await fetch(`${TG_BASE}/deleteWebhook`);
  const res = await fetch(
    `${TG_BASE}/setWebhook?url=${encodeURIComponent(webhookUrl)}`
  );
  return res.text();
}
