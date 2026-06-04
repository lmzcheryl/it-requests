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
  await post('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}

export async function sendInlineKeyboard(
  chatId: number,
  text: string,
  rows: string[][]
): Promise<void> {
  await post('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: rows.map((row) =>
        row.map((label) => ({ text: label, callback_data: label }))
      ),
    },
  });
}

// Like sendInlineKeyboard but accepts pre-formed button objects
export async function sendButtons(
  chatId: number,
  text: string,
  rows: { text: string; callback_data: string }[][]
): Promise<void> {
  await post('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  });
}

export async function answerCallback(callbackQueryId: string): Promise<void> {
  await post('answerCallbackQuery', { callback_query_id: callbackQueryId });
}

export async function removeButtons(chatId: number, messageId: number): Promise<void> {
  await post('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  });
}

export async function setWebhook(webhookUrl: string): Promise<string> {
  await fetch(`${TG_BASE}/deleteWebhook`);
  const res = await fetch(`${TG_BASE}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
  return res.text();
}

export async function registerCommands(): Promise<void> {
  await post('setMyCommands', {
    commands: [
      { command: 'pending',  description: '📋 View open requests' },
      { command: 'all',      description: '📊 View all requests including Done' },
      { command: 'help',     description: '❓ Show all commands' },
      { command: 'cancel',   description: '✖️ Exit current flow' },
    ],
  });
}
