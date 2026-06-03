import { sendMessage, sendInlineKeyboard, answerCallback } from './telegram';
import {
  appendRequest,
  clearState,
  getOverdueRequests,
  getRecentRequestors,
  getRow,
  getPendingRequests,
  getState,
  markReminded,
  setState,
  updateField,
  Request,
} from './supabase';

// ── Types ──────────────────────────────────────────────────────

interface ForwardOrigin {
  type: 'user' | 'hidden_user' | 'channel' | 'chat';
  sender_user?: { first_name: string; last_name?: string };
  sender_user_name?: string;
  chat?: { title: string };
}

interface TelegramMessage {
  chat: { id: number };
  text?: string;
  caption?: string;
  forward_origin?: ForwardOrigin;
  forward_from?: { first_name: string; last_name?: string };
  forward_sender_name?: string;
  forward_from_chat?: object;
  forward_date?: number;
}

interface CallbackQuery {
  id: string;
  data?: string;
  message?: { chat: { id: number } };
}

interface FlowState {
  step: 'ask_requestor' | 'post_log' | 'priority' | 'complexity' | 'status' | 'remarks';
  rowId?: number;
  requestText?: string;
  priority?: string;
}

// ── Text helpers ───────────────────────────────────────────────

function h(text: string): string {
  // Escape user content for HTML parse mode
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function b(text: string): string {
  return `<b>${text}</b>`;
}

// Take first non-empty line and cap at maxLen
function excerpt(text: string, maxLen = 80): string {
  const line = text.split('\n').map(l => l.trim()).find(l => l.length > 0) || text;
  return h(line.length > maxLen ? line.slice(0, maxLen - 1) + '…' : line);
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function getAge(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  const h = Math.floor(ms / 3600000);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// ── Entry point ────────────────────────────────────────────────

export async function handleUpdate(update: {
  message?: TelegramMessage;
  callback_query?: CallbackQuery;
}): Promise<void> {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }
  if (update.message) {
    await handleMessage(update.message);
  }
}

// ── Reminders ─────────────────────────────────────────────────

const PRIORITY_GUIDE: Record<string, string> = {
  Urgent: 'Drop everything — fix now.',
  High:   'Today or tomorrow.',
  Med:    'Within the week.',
  Low:    'Nice to have, no hard deadline.',
};

export async function checkReminders(): Promise<void> {
  const overdue = await getOverdueRequests();
  for (const req of overdue) {
    const guide = PRIORITY_GUIDE[req.priority!] || '';
    await sendMessage(
      req.chat_id,
      `⏰ ${b('Reminder')} — ${b('#' + req.id)} is still open\n\n` +
      `👤 ${h(req.requestor)}\n` +
      `📝 ${excerpt(req.request_text)}\n` +
      `🔺 ${h(req.priority || '—')} · ${h(req.status)} · ${getAge(req.created_at)} old\n\n` +
      `<i>${h(guide)}</i>\n\n` +
      `/edit ${req.id} — update status`
    );
    await markReminded(req.id);
  }
}

// ── Callback query handler ─────────────────────────────────────

async function handleCallbackQuery(cq: CallbackQuery): Promise<void> {
  await answerCallback(cq.id);
  const chatId = cq.message?.chat.id;
  if (!chatId || !cq.data) return;

  const stateJson = await getState(chatId);
  if (!stateJson) return;

  const state: FlowState = JSON.parse(stateJson);
  const data = cq.data;

  if (state.step === 'ask_requestor') {
    if (data === 'Other (type name)') {
      await sendMessage(chatId, "Type the requestor's name:");
      return;
    }
    await logAndConfirm(chatId, data, state.requestText!);
    return;
  }

  if (state.step === 'post_log') {
    if (data === 'Fill other fields now') {
      await startFillFlow(chatId, state.rowId!);
    } else {
      await clearState(chatId);
      await sendMessage(
        chatId,
        `Got it. ${b('#' + state.rowId)} is saved.\n\n` +
        `/pending — see all open requests\n` +
        `/edit ${state.rowId} — come back to this one`
      );
    }
    return;
  }

  if (state.step === 'priority') {
    if (data !== 'Skip') await updateField(state.rowId!, 'priority', data);
    await askComplexity(chatId, state.rowId!, data !== 'Skip' ? data : undefined);
    return;
  }

  if (state.step === 'complexity') {
    if (data !== 'Skip') await updateField(state.rowId!, 'complexity', data);
    if (state.priority && data !== 'Skip') {
      const suggestion = getSuggestion(state.priority, data);
      if (suggestion) await sendMessage(chatId, suggestion);
    }
    await askStatus(chatId, state.rowId!);
    return;
  }

  if (state.step === 'status') {
    if (data !== 'Skip' && data !== 'Keep as New') {
      await updateField(state.rowId!, 'status', data);
    }
    await askRemarks(chatId, state.rowId!);
    return;
  }

  if (state.step === 'remarks') {
    await clearState(chatId);
    const row = await getRow(state.rowId!);
    await sendMessage(chatId, formatUpdatedSummary(state.rowId!, row));
    return;
  }
}

// ── Message handler ────────────────────────────────────────────

async function handleMessage(msg: TelegramMessage): Promise<void> {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const stateJson = await getState(chatId);

  if (text === '/pending') { await sendPending(chatId); return; }

  const editMatch = text.match(/^\/edit\D*(\d+)/);
  if (editMatch) { await startFillFlow(chatId, parseInt(editMatch[1])); return; }

  if (stateJson) {
    const state: FlowState = JSON.parse(stateJson);

    if (state.step === 'ask_requestor') {
      await logAndConfirm(chatId, text, state.requestText!);
      return;
    }

    if (state.step === 'remarks') {
      await updateField(state.rowId!, 'remarks', text);
      await clearState(chatId);
      const row = await getRow(state.rowId!);
      await sendMessage(chatId, formatUpdatedSummary(state.rowId!, row));
      return;
    }

    return;
  }

  const isForward =
    msg.forward_origin ||
    msg.forward_from ||
    msg.forward_sender_name ||
    msg.forward_from_chat ||
    msg.forward_date;

  if (isForward) { await handleForward(msg, chatId); return; }

  await sendMessage(
    chatId,
    'Forward me a message to log a request.\n\n' +
    '/pending — open requests\n' +
    '/edit 23 — update a row'
  );
}

// ── Forward handler ────────────────────────────────────────────

async function handleForward(msg: TelegramMessage, chatId: number): Promise<void> {
  const requestText = msg.text || msg.caption || '(no text)';
  let requestor: string | null = null;

  if (msg.forward_origin) {
    const o = msg.forward_origin;
    if (o.type === 'user' && o.sender_user) {
      requestor = [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ');
    } else if (o.type === 'hidden_user' && o.sender_user_name) {
      requestor = o.sender_user_name;
    } else if (o.type === 'channel' && o.chat) {
      requestor = o.chat.title;
    }
  }

  if (!requestor && msg.forward_from) {
    requestor = [msg.forward_from.first_name, msg.forward_from.last_name]
      .filter(Boolean).join(' ');
  }

  if (!requestor && msg.forward_sender_name) {
    requestor = msg.forward_sender_name;
  }

  if (!requestor) {
    const recent = await getRecentRequestors();
    const rows = recent.map((name) => [name]);
    rows.push(['Other (type name)']);
    await sendInlineKeyboard(
      chatId,
      "⚠️ Couldn't read the sender's name (privacy settings).\nWho's the requestor?",
      rows
    );
    await setState(chatId, JSON.stringify({ step: 'ask_requestor', requestText }));
    return;
  }

  await logAndConfirm(chatId, requestor, requestText);
}

// ── Log + confirm ──────────────────────────────────────────────

async function logAndConfirm(chatId: number, requestor: string, requestText: string): Promise<void> {
  const id = await appendRequest(requestor, requestText, chatId);
  const date = new Date().toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });

  await sendInlineKeyboard(
    chatId,
    `✅ ${b('Logged as #' + id)}\n\n` +
    `👤 ${b('Requestor:')} ${h(requestor)}\n` +
    `📝 ${b('Request:')} ${excerpt(requestText, 120)}\n` +
    `📅 ${h(date)}\n` +
    `🔵 Status: New`,
    [['Fill other fields now', 'Do it later']]
  );
  await setState(chatId, JSON.stringify({ step: 'post_log', rowId: id }));
}

// ── Fill-flow steps ────────────────────────────────────────────

async function startFillFlow(chatId: number, rowId: number): Promise<void> {
  const row = await getRow(rowId);
  if (!row) {
    await sendMessage(chatId, `❌ Request #${rowId} not found.`);
    return;
  }

  await sendMessage(
    chatId,
    `📋 ${b('Request #' + row.id)}\n\n` +
    `👤 ${b(h(row.requestor))}\n` +
    `📝 ${excerpt(row.request_text, 120)}\n\n` +
    `Priority    ${h(row.priority   || '—')}\n` +
    `Complexity  ${h(row.complexity || '—')}\n` +
    `Status      ${h(row.status)}\n` +
    `Requested   ${formatDate(row.requested_date)}\n\n` +
    `Let's fill in the details 👇`
  );

  await askPriority(chatId, rowId);
}

async function askPriority(chatId: number, rowId: number): Promise<void> {
  await sendInlineKeyboard(
    chatId,
    `${b('Step 1 of 4 — Priority')}\nWhat's the priority for #${rowId}?`,
    [['Urgent', 'High', 'Med', 'Low'], ['Skip']]
  );
  await setState(chatId, JSON.stringify({ step: 'priority', rowId }));
}

async function askComplexity(chatId: number, rowId: number, priority?: string): Promise<void> {
  await sendInlineKeyboard(
    chatId,
    `${b('Step 2 of 4 — Complexity')}\nComplexity?`,
    [
      ['Minimal (half a day)', 'Moderate (1-2 days)'],
      ['Heavy (More than 2 days)', 'Long term (1 Month)'],
      ['Skip'],
    ]
  );
  await setState(chatId, JSON.stringify({ step: 'complexity', rowId, priority }));
}

async function askStatus(chatId: number, rowId: number): Promise<void> {
  const row = await getRow(rowId);
  const current = row?.status || 'New';
  await sendInlineKeyboard(
    chatId,
    `${b('Step 3 of 4 — Status')}\nStatus? (currently ${h(current)})`,
    [
      ['New', 'In Progress', 'Blocked'],
      ['Done', 'Keep as New'],
    ]
  );
  await setState(chatId, JSON.stringify({ step: 'status', rowId }));
}

async function askRemarks(chatId: number, rowId: number): Promise<void> {
  await sendInlineKeyboard(
    chatId,
    `${b('Step 4 of 4 — Remarks')}\nAny remarks? (reply with text or skip)`,
    [['Skip']]
  );
  await setState(chatId, JSON.stringify({ step: 'remarks', rowId }));
}

// ── /pending ───────────────────────────────────────────────────

async function sendPending(chatId: number): Promise<void> {
  const rows = await getPendingRequests();

  if (!rows.length) {
    await sendMessage(chatId, 'No open requests right now 🎉');
    return;
  }

  const lines = rows.slice(0, 5).map((r) =>
    `${b('#' + r.id)} · ${h(r.requestor)}\n` +
    `${excerpt(r.request_text, 70)}\n` +
    `${h(r.priority || '—')} · ${h(r.status)}`
  );

  await sendMessage(
    chatId,
    `${b('Open requests (' + rows.length + ')')}\n\n` +
    lines.join('\n\n') +
    '\n\n/edit [id] to update a row'
  );
}

// ── Suggestion engine ──────────────────────────────────────────

function getSuggestion(priority: string, complexity: string): string {
  const c = complexity.toLowerCase();
  const isMinimal  = c.includes('minimal');
  const isModerate = c.includes('moderate');
  const isHeavy    = c.includes('heavy');

  if (priority === 'Urgent') {
    if (isMinimal)  return '💡 Drop everything — aim to complete within 4 hours (quick fix).';
    if (isModerate) return '💡 Drop everything — aim to wrap up by end of day (1-2 days of work).';
    if (isHeavy)    return '💡 Drop everything — heavy effort but urgent. Loop in help if needed.';
    return '💡 Drop everything — long haul but urgent. Break it into milestones and start now.';
  }
  if (priority === 'High') {
    if (isMinimal)  return '💡 Today or tomorrow — it\'s a quick fix, no reason to delay.';
    if (isModerate) return '💡 Today or tomorrow — block time for this, it\'ll take 1-2 days.';
    if (isHeavy)    return '💡 Start today, target completion by end of week.';
    return '💡 High priority but a long haul — start planning now, set a milestone this week.';
  }
  if (priority === 'Med') {
    return '💡 Within the week — don\'t let it slip past Friday.';
  }
  if (priority === 'Low') {
    return '💡 Nice to have — pick it up when you have spare capacity.';
  }
  return '';
}

// ── Formatted summaries ────────────────────────────────────────

function formatUpdatedSummary(rowId: number, row: Request | null): string {
  return (
    `✅ ${b('#' + rowId + ' updated')}\n\n` +
    `Priority    ${h(row?.priority   || '—')}\n` +
    `Complexity  ${h(row?.complexity || '—')}\n` +
    `Status      ${h(row?.status     || 'New')}\n` +
    `Remarks     ${h(row?.remarks    || '—')}`
  );
}
