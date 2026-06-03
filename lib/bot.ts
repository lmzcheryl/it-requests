import { sendMessage, sendKeyboard } from './telegram';
import {
  appendRequest,
  clearState,
  getRecentRequestors,
  getRow,
  getPendingRequests,
  getState,
  setState,
  updateField,
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
  forward_from_chat?: { title: string };
  forward_date?: number;
}

interface FlowState {
  step: 'ask_requestor' | 'post_log' | 'priority' | 'complexity' | 'status' | 'remarks';
  rowId?: number;
  requestText?: string;
}

// ── Entry point ────────────────────────────────────────────────

export async function handleUpdate(update: { message?: TelegramMessage }): Promise<void> {
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const stateJson = await getState(chatId);

  if (text === '/pending') { await sendPending(chatId); return; }

  const editMatch = text.match(/^\/edit\s+(\d+)/);
  if (editMatch) { await startFillFlow(chatId, parseInt(editMatch[1])); return; }

  if (stateJson) { await handleFlowStep(chatId, text, stateJson); return; }

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
    '/edit [id] — update a row'
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
    const buttons = recent.length ? [...recent, 'Other (type name)'] : ['Type name below'];
    await sendKeyboard(
      chatId,
      "⚠️ Couldn't read the sender's name (privacy settings). Who's the requestor?",
      buttons
    );
    await setState(chatId, JSON.stringify({ step: 'ask_requestor', requestText }));
    return;
  }

  await logAndConfirm(chatId, requestor, requestText);
}

// ── Log + alert ────────────────────────────────────────────────

async function logAndConfirm(chatId: number, requestor: string, requestText: string): Promise<void> {
  const id = await appendRequest(requestor, requestText, chatId);
  const date = new Date().toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
  await sendKeyboard(
    chatId,
    `✅ New request logged — #${id}\n\n` +
    `👤 Requestor: ${requestor}\n` +
    `📝 Request: ${requestText}\n` +
    `📅 Date: ${date}\n` +
    `🔵 Status: New`,
    ['Fill details now', 'Do it later']
  );
  await setState(chatId, JSON.stringify({ step: 'post_log', rowId: id }));
}

// ── Conversational flow ────────────────────────────────────────

async function handleFlowStep(chatId: number, text: string, stateJson: string): Promise<void> {
  const state: FlowState = JSON.parse(stateJson);

  if (state.step === 'ask_requestor') {
    if (text === 'Other (type name)' || text === 'Type name below') {
      await sendMessage(chatId, "Type the requestor's name:");
      return;
    }
    await logAndConfirm(chatId, text, state.requestText!);
    return;
  }

  if (state.step === 'post_log') {
    if (text === 'Fill details now') {
      await startFillFlow(chatId, state.rowId!);
    } else {
      await clearState(chatId);
      await sendMessage(
        chatId,
        `Got it. #${state.rowId} is saved.\n\n` +
        `/pending — see open requests\n` +
        `/edit ${state.rowId} — fill details later`
      );
    }
    return;
  }

  if (state.step === 'priority') {
    if (text !== 'Skip') await updateField(state.rowId!, 'priority', text);
    await askComplexity(chatId, state.rowId!);
    return;
  }

  if (state.step === 'complexity') {
    if (text !== 'Skip') await updateField(state.rowId!, 'complexity', text);
    await askStatus(chatId, state.rowId!);
    return;
  }

  if (state.step === 'status') {
    if (text !== 'Skip') await updateField(state.rowId!, 'status', text);
    await askRemarks(chatId, state.rowId!);
    return;
  }

  if (state.step === 'remarks') {
    if (text !== 'Skip') await updateField(state.rowId!, 'remarks', text);
    await clearState(chatId);
    const row = await getRow(state.rowId!);
    await sendMessage(
      chatId,
      `✅ #${state.rowId} updated\n\n` +
      `Priority:   ${row?.priority   || '—'}\n` +
      `Complexity: ${row?.complexity || '—'}\n` +
      `Status:     ${row?.status     || 'New'}\n` +
      `Remarks:    ${row?.remarks    || '—'}`
    );
    return;
  }
}

// ── Fill-flow steps ────────────────────────────────────────────

async function startFillFlow(chatId: number, rowId: number): Promise<void> {
  await askPriority(chatId, rowId);
}

async function askPriority(chatId: number, rowId: number): Promise<void> {
  await sendKeyboard(chatId, `Priority for #${rowId}?`, ['High', 'Med', 'Low', 'Skip']);
  await setState(chatId, JSON.stringify({ step: 'priority', rowId }));
}

async function askComplexity(chatId: number, rowId: number): Promise<void> {
  await sendKeyboard(chatId, 'Complexity?', [
    'Minimal (half a day)',
    'Moderate (1-2 days)',
    'Heavy (More than 2 days)',
    'Long term (1 Month)',
    'Skip',
  ]);
  await setState(chatId, JSON.stringify({ step: 'complexity', rowId }));
}

async function askStatus(chatId: number, rowId: number): Promise<void> {
  await sendKeyboard(chatId, 'Status?', [
    'New', 'In Progress', 'On Hold', 'Stuck', 'Completed', 'Closed', 'Skip',
  ]);
  await setState(chatId, JSON.stringify({ step: 'status', rowId }));
}

async function askRemarks(chatId: number, rowId: number): Promise<void> {
  await sendKeyboard(chatId, 'Any remarks? Type a message or tap Skip.', ['Skip']);
  await setState(chatId, JSON.stringify({ step: 'remarks', rowId }));
}

// ── /pending ───────────────────────────────────────────────────

async function sendPending(chatId: number): Promise<void> {
  const rows = await getPendingRequests();

  if (!rows.length) {
    await sendMessage(chatId, 'No open requests right now 🎉');
    return;
  }

  const lines = rows.slice(0, 5).map(
    (r) => `#${r.id} — ${r.request_text}\n  ${r.requestor} · ${r.priority || '—'} · ${r.status}`
  );

  await sendMessage(
    chatId,
    `Open requests (${rows.length}):\n\n` +
    lines.join('\n\n') +
    '\n\nUse /edit [id] to update any row.'
  );
}
