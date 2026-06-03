import { sendMessage, sendInlineKeyboard, answerCallback } from './telegram';
import {
  appendRequest,
  appendSignalLog,
  clearState,
  getAllRequests,
  getOverdueRequests,
  getRecentRequestors,
  getRow,
  getPendingRequests,
  getSignalRow,
  getState,
  markReminded,
  setState,
  updateField,
  updateSignalField,
  Request,
  SignalLog,
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
  from?: { first_name: string; last_name?: string };
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
  step:
    | 'ask_requestor' | 'post_log'
    | 'priority' | 'complexity' | 'status' | 'remarks'
    | 'ask_signal'
    | 'signal_type' | 'signal_impact' | 'signal_temp_fix'
    | 'signal_root_cause' | 'signal_kaizen' | 'signal_resolved';
  rowId?: number;
  signalId?: number;
  requestText?: string;
  loggedBy?: string;
  priority?: string;
}

// ── Text helpers ───────────────────────────────────────────────

function h(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function b(text: string): string { return `<b>${text}</b>`; }

function excerpt(text: string, maxLen = 80): string {
  const line = text.split('\n').map(l => l.trim()).find(l => l.length > 0) || text;
  return h(line.length > maxLen ? line.slice(0, maxLen - 1) + '…' : line);
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function shortDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
function getAge(createdAt: string): string {
  const hr = Math.floor((Date.now() - new Date(createdAt).getTime()) / 3600000);
  return hr < 24 ? `${hr}h` : `${Math.floor(hr / 24)}d`;
}

// ── Entry point ────────────────────────────────────────────────

export async function handleUpdate(update: {
  message?: TelegramMessage;
  callback_query?: CallbackQuery;
}): Promise<void> {
  if (update.callback_query) { await handleCallbackQuery(update.callback_query); return; }
  if (update.message)        { await handleMessage(update.message); }
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
    await sendMessage(req.chat_id,
      `⏰ ${b('Reminder')} — ${b('#' + req.id)} is still open\n\n` +
      `👤 ${h(req.requestor)}\n📝 ${excerpt(req.request_text)}\n` +
      `🔺 ${h(req.priority || '—')} · ${h(req.status)} · ${getAge(req.created_at)} old\n\n` +
      `<i>${h(PRIORITY_GUIDE[req.priority!] || '')}</i>\n\n/edit ${req.id} — update status`
    );
    await markReminded(req.id);
  }
}

// ── Callback query handler ─────────────────────────────────────

async function handleCallbackQuery(cq: CallbackQuery): Promise<void> {
  await answerCallback(cq.id);
  const chatId = cq.message?.chat.id;
  if (!chatId || !cq.data) return;

  // Edit button from /pending
  if (cq.data.startsWith('edit:')) {
    await clearState(chatId);
    await startFillFlow(chatId, parseInt(cq.data.split(':')[1]));
    return;
  }

  const stateJson = await getState(chatId);
  if (!stateJson) return;
  const state: FlowState = JSON.parse(stateJson);
  const data = cq.data;

  // ── IT Request flow ──────────────────────────────────────────

  if (state.step === 'ask_requestor') {
    if (data === 'Other (type name)') { await sendMessage(chatId, "Type the requestor's name:"); return; }
    await logAndConfirm(chatId, data, state.requestText!, state.loggedBy!);
    return;
  }

  if (state.step === 'post_log') {
    if (data === 'Fill other fields now') {
      await startFillFlow(chatId, state.rowId!, state.loggedBy);
    } else {
      await clearState(chatId);
      await sendMessage(chatId,
        `Got it. ${b('#' + state.rowId)} is saved.\n\n/pending — see all open requests\n/edit ${state.rowId} — come back to this one`
      );
    }
    return;
  }

  if (state.step === 'priority') {
    if (data !== 'Skip') await updateField(state.rowId!, 'priority', data);
    await askComplexity(chatId, state.rowId!, data !== 'Skip' ? data : undefined, state.loggedBy);
    return;
  }

  if (state.step === 'complexity') {
    if (data !== 'Skip') await updateField(state.rowId!, 'complexity', data);
    if (state.priority && data !== 'Skip') {
      const sug = getSuggestion(state.priority, data);
      if (sug) await sendMessage(chatId, sug);
    }
    await askStatus(chatId, state.rowId!, state.loggedBy);
    return;
  }

  if (state.step === 'status') {
    if (data !== 'Skip' && data !== 'Keep as New') await updateField(state.rowId!, 'status', data);
    await askRemarks(chatId, state.rowId!, state.loggedBy);
    return;
  }

  if (state.step === 'remarks') {
    // Skip tapped — go to signal question
    await askSignalQuestion(chatId, state.rowId!, state.loggedBy!);
    return;
  }

  // ── Signal decision ──────────────────────────────────────────

  if (state.step === 'ask_signal') {
    if (data === 'Yes — add signal details') {
      const row = await getRow(state.rowId!);
      await startSignalFlow(chatId, state.rowId!, row?.request_text || '', state.loggedBy!);
    } else {
      await clearState(chatId);
      const row = await getRow(state.rowId!);
      await sendMessage(chatId, formatRequestSummary(state.rowId!, row));
    }
    return;
  }

  // ── Signal fill flow ─────────────────────────────────────────

  if (state.step === 'signal_type') {
    if (data !== 'Skip') await updateSignalField(state.signalId!, 'signal_type', data);
    await askSignalImpact(chatId, state.signalId!, state.rowId, state.loggedBy);
    return;
  }
  if (state.step === 'signal_impact') {
    // Skip tapped
    await askSignalTempFix(chatId, state.signalId!, state.rowId, state.loggedBy);
    return;
  }
  if (state.step === 'signal_temp_fix') {
    await askSignalRootCause(chatId, state.signalId!, state.rowId, state.loggedBy);
    return;
  }
  if (state.step === 'signal_root_cause') {
    await askSignalKaizen(chatId, state.signalId!, state.rowId, state.loggedBy);
    return;
  }
  if (state.step === 'signal_kaizen') {
    await askSignalResolved(chatId, state.signalId!, state.rowId);
    return;
  }
  if (state.step === 'signal_resolved') {
    if (data !== 'Skip') await updateSignalField(state.signalId!, 'resolved', data);
    await clearState(chatId);
    const row = await getRow(state.rowId!);
    const sig = await getSignalRow(state.signalId!);
    await sendMessage(chatId, formatCombinedSummary(state.rowId!, row, state.signalId!, sig));
    return;
  }
}

// ── Message handler ────────────────────────────────────────────

async function handleMessage(msg: TelegramMessage): Promise<void> {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const stateJson = await getState(chatId);
  const loggedBy = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Unknown';

  if (text === '/pending') { await sendPending(chatId, false); return; }
  if (text === '/all')     { await sendPending(chatId, true);  return; }

  const editMatch = text.match(/^\/edit\D*(\d+)/);
  if (editMatch) { await startFillFlow(chatId, parseInt(editMatch[1]), loggedBy); return; }

  // Forwards always take priority
  const isForward = msg.forward_origin || msg.forward_from || msg.forward_sender_name || msg.forward_from_chat || msg.forward_date;
  if (isForward) {
    await clearState(chatId);
    await handleForward(msg, chatId, loggedBy);
    return;
  }

  if (stateJson) {
    const state: FlowState = JSON.parse(stateJson);

    if (state.step === 'ask_requestor') {
      await logAndConfirm(chatId, text, state.requestText!, state.loggedBy!);
      return;
    }
    if (state.step === 'remarks') {
      await updateField(state.rowId!, 'remarks', text);
      await askSignalQuestion(chatId, state.rowId!, state.loggedBy!);
      return;
    }
    // Signal free-text steps
    if (state.step === 'signal_impact') {
      await updateSignalField(state.signalId!, 'impact', text);
      await askSignalTempFix(chatId, state.signalId!, state.rowId, state.loggedBy);
      return;
    }
    if (state.step === 'signal_temp_fix') {
      await updateSignalField(state.signalId!, 'temporary_fix', text);
      await askSignalRootCause(chatId, state.signalId!, state.rowId, state.loggedBy);
      return;
    }
    if (state.step === 'signal_root_cause') {
      await updateSignalField(state.signalId!, 'root_cause_guess', text);
      await askSignalKaizen(chatId, state.signalId!, state.rowId, state.loggedBy);
      return;
    }
    if (state.step === 'signal_kaizen') {
      await updateSignalField(state.signalId!, 'kaizen_ideas', text);
      await askSignalResolved(chatId, state.signalId!, state.rowId);
      return;
    }
    return;
  }

  await sendMessage(chatId,
    'Forward me a message to log a request.\n\n/pending — open requests\n/all — all requests incl. Done\n/edit 23 — update a row'
  );
}

// ── Forward handler ────────────────────────────────────────────

async function handleForward(msg: TelegramMessage, chatId: number, loggedBy: string): Promise<void> {
  const requestText = msg.text || msg.caption || '(no text)';
  let requestor: string | null = null;

  if (msg.forward_origin) {
    const o = msg.forward_origin;
    if (o.type === 'user' && o.sender_user)
      requestor = [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ');
    else if (o.type === 'hidden_user' && o.sender_user_name) requestor = o.sender_user_name;
    else if (o.type === 'channel' && o.chat) requestor = o.chat.title;
  }
  if (!requestor && msg.forward_from)
    requestor = [msg.forward_from.first_name, msg.forward_from.last_name].filter(Boolean).join(' ');
  if (!requestor && msg.forward_sender_name) requestor = msg.forward_sender_name;

  if (!requestor) {
    const recent = await getRecentRequestors();
    const rows = recent.map(name => [name]);
    rows.push(['Other (type name)']);
    await sendInlineKeyboard(chatId,
      "⚠️ Couldn't read the sender's name.\nWho's the requestor?",
      rows
    );
    await setState(chatId, JSON.stringify({ step: 'ask_requestor', requestText, loggedBy }));
    return;
  }

  await logAndConfirm(chatId, requestor, requestText, loggedBy);
}

// ── IT Request: log + confirm ──────────────────────────────────

async function logAndConfirm(chatId: number, requestor: string, requestText: string, loggedBy: string): Promise<void> {
  const id = await appendRequest(requestor, requestText, chatId);
  const date = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  await sendInlineKeyboard(chatId,
    `✅ ${b('Logged as #' + id)}\n\n👤 ${b('Requestor:')} ${h(requestor)}\n📝 ${b('Request:')} ${excerpt(requestText, 120)}\n📅 ${h(date)}\n🔵 Status: New`,
    [['Fill other fields now', 'Do it later']]
  );
  await setState(chatId, JSON.stringify({ step: 'post_log', rowId: id, loggedBy }));
}

// ── IT Request: fill flow ──────────────────────────────────────

async function startFillFlow(chatId: number, rowId: number, loggedBy?: string): Promise<void> {
  const row = await getRow(rowId);
  if (!row) { await sendMessage(chatId, `❌ Request #${rowId} not found.`); return; }
  await sendMessage(chatId,
    `📋 ${b('Request #' + row.id)}\n\n👤 ${b(h(row.requestor))}\n📝 ${excerpt(row.request_text, 120)}\n\n` +
    `Priority    ${h(row.priority || '—')}\nComplexity  ${h(row.complexity || '—')}\nStatus      ${h(row.status)}\nRequested   ${formatDate(row.requested_date)}\n\nLet's fill in the details 👇`
  );
  await askPriority(chatId, rowId, loggedBy);
}

async function askPriority(chatId: number, rowId: number, loggedBy?: string): Promise<void> {
  await sendInlineKeyboard(chatId,
    `${b('Step 1 of 4 — Priority')}\nWhat's the priority for #${rowId}?`,
    [['Urgent', 'High', 'Med', 'Low'], ['Skip']]
  );
  await setState(chatId, JSON.stringify({ step: 'priority', rowId, loggedBy }));
}

async function askComplexity(chatId: number, rowId: number, priority?: string, loggedBy?: string): Promise<void> {
  await sendInlineKeyboard(chatId, `${b('Step 2 of 4 — Complexity')}\nComplexity?`,
    [['Minimal (half a day)', 'Moderate (1-2 days)'], ['Heavy (More than 2 days)', 'Long term (1 Month)'], ['Skip']]
  );
  await setState(chatId, JSON.stringify({ step: 'complexity', rowId, priority, loggedBy }));
}

async function askStatus(chatId: number, rowId: number, loggedBy?: string): Promise<void> {
  const row = await getRow(rowId);
  await sendInlineKeyboard(chatId,
    `${b('Step 3 of 4 — Status')}\nStatus? (currently ${h(row?.status || 'New')})`,
    [['New', 'In Progress', 'Blocked'], ['Done', 'Keep as New']]
  );
  await setState(chatId, JSON.stringify({ step: 'status', rowId, loggedBy }));
}

async function askRemarks(chatId: number, rowId: number, loggedBy?: string): Promise<void> {
  await sendInlineKeyboard(chatId,
    `${b('Step 4 of 4 — Remarks')}\nAny remarks? (reply with text or skip)`,
    [['Skip']]
  );
  await setState(chatId, JSON.stringify({ step: 'remarks', rowId, loggedBy }));
}

async function askSignalQuestion(chatId: number, rowId: number, loggedBy: string): Promise<void> {
  await sendInlineKeyboard(chatId,
    `📊 ${b('Is this also a Signal Log?')}\n\nSignal logs track recurring issues, bugs, or process gaps for future improvement.`,
    [['Yes — add signal details', 'No, done']]
  );
  await setState(chatId, JSON.stringify({ step: 'ask_signal', rowId, loggedBy }));
}

// ── Signal: log + fill flow ────────────────────────────────────

async function startSignalFlow(chatId: number, rowId: number, whatHappened: string, loggedBy: string): Promise<void> {
  const signalId = await appendSignalLog(whatHappened, loggedBy, chatId, rowId);
  await sendMessage(chatId, `📊 ${b('Signal Log #' + signalId + ' created')} — linked to IT Request #${rowId}\n\nLet's categorise it 👇`);
  await askSignalType(chatId, signalId, rowId, loggedBy);
}

async function askSignalType(chatId: number, signalId: number, rowId?: number, loggedBy?: string): Promise<void> {
  await sendInlineKeyboard(chatId, `${b('Signal Step 1 of 5 — Type')}\nWhat type of signal is this?`,
    [
      ['Recurring Manual work', 'Bugs'],
      ['Process unclear or not followed', 'Unplanned firefighting'],
      ["Can't trace why this is happening", 'Recurring system error'],
      ['Skip'],
    ]
  );
  await setState(chatId, JSON.stringify({ step: 'signal_type', signalId, rowId, loggedBy }));
}

async function askSignalImpact(chatId: number, signalId: number, rowId?: number, loggedBy?: string): Promise<void> {
  await sendInlineKeyboard(chatId, `${b('Signal Step 2 of 5 — Impact')}\nWhat's the impact? (reply with text or skip)`, [['Skip']]);
  await setState(chatId, JSON.stringify({ step: 'signal_impact', signalId, rowId, loggedBy }));
}

async function askSignalTempFix(chatId: number, signalId: number, rowId?: number, loggedBy?: string): Promise<void> {
  await sendInlineKeyboard(chatId, `${b('Signal Step 3 of 5 — Temporary Fix')}\nAny temporary fix applied? (reply with text or skip)`, [['Skip']]);
  await setState(chatId, JSON.stringify({ step: 'signal_temp_fix', signalId, rowId, loggedBy }));
}

async function askSignalRootCause(chatId: number, signalId: number, rowId?: number, loggedBy?: string): Promise<void> {
  await sendInlineKeyboard(chatId, `${b('Signal Step 4 of 5 — Root Cause Guess')}\nWhat do you think caused this? (reply with text or skip)`, [['Skip']]);
  await setState(chatId, JSON.stringify({ step: 'signal_root_cause', signalId, rowId, loggedBy }));
}

async function askSignalKaizen(chatId: number, signalId: number, rowId?: number, loggedBy?: string): Promise<void> {
  await sendInlineKeyboard(chatId, `${b('Signal Step 5 of 5 — Kaizen Ideas')}\nAny ideas to improve or prevent this? (reply with text or skip)`, [['Skip']]);
  await setState(chatId, JSON.stringify({ step: 'signal_kaizen', signalId, rowId, loggedBy }));
}

async function askSignalResolved(chatId: number, signalId: number, rowId?: number): Promise<void> {
  await sendInlineKeyboard(chatId, `${b('Resolved?')}\nIs this resolved?`, [['Yes', 'No', 'Skip']]);
  await setState(chatId, JSON.stringify({ step: 'signal_resolved', signalId, rowId }));
}

// ── /pending ───────────────────────────────────────────────────

async function sendPending(chatId: number, includeAll: boolean): Promise<void> {
  const rows = includeAll ? await getAllRequests() : await getPendingRequests();
  const label = includeAll ? 'All requests' : 'Open requests';
  if (!rows.length) { await sendMessage(chatId, 'No requests found 🎉'); return; }

  const shown = rows.slice(0, 8);
  const lines = shown.map(r =>
    `${b('#' + r.id)}  ${excerpt(r.request_text, 60)}\n${h(r.requestor)} · ${h(r.priority || '—')} · ${h(r.status)} · ${shortDate(r.requested_date)}`
  );
  const editButtons = shown.map(r => [{ text: `✏️ #${r.id}`, callback_data: `edit:${r.id}` }]);

  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `${b(label + ' (' + rows.length + ')')}\n\n` + lines.join('\n\n') + (includeAll ? '' : '\n\n/all — see all including Done'),
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: editButtons },
    }),
  });
}

// ── Suggestion engine ──────────────────────────────────────────

function getSuggestion(priority: string, complexity: string): string {
  const c = complexity.toLowerCase();
  const isMinimal = c.includes('minimal'), isModerate = c.includes('moderate'), isHeavy = c.includes('heavy');
  if (priority === 'Urgent') {
    if (isMinimal)  return '💡 Drop everything — aim to complete within 4 hours (quick fix).';
    if (isModerate) return '💡 Drop everything — aim to wrap up by end of day.';
    return '💡 Drop everything — heavy effort but urgent. Loop in help if needed.';
  }
  if (priority === 'High') {
    if (isMinimal)  return '💡 Today or tomorrow — quick fix, no reason to delay.';
    if (isModerate) return '💡 Today or tomorrow — block time for this.';
    if (isHeavy)    return '💡 Start today, target completion by end of week.';
    return '💡 High priority, long haul — start planning, set a milestone this week.';
  }
  if (priority === 'Med') return '💡 Within the week — don\'t let it slip past Friday.';
  if (priority === 'Low') return '💡 Nice to have — pick it up when you have spare capacity.';
  return '';
}

// ── Summaries ──────────────────────────────────────────────────

function formatRequestSummary(rowId: number, row: Request | null): string {
  return (
    `✅ ${b('#' + rowId + ' updated')}\n\n` +
    `Priority    ${h(row?.priority   || '—')}\n` +
    `Complexity  ${h(row?.complexity || '—')}\n` +
    `Status      ${h(row?.status     || 'New')}\n` +
    `Remarks     ${h(row?.remarks    || '—')}`
  );
}

function formatCombinedSummary(rowId: number, row: Request | null, signalId: number, sig: SignalLog | null): string {
  return (
    `✅ ${b('#' + rowId + ' updated')}\n\n` +
    `Priority    ${h(row?.priority   || '—')}\n` +
    `Complexity  ${h(row?.complexity || '—')}\n` +
    `Status      ${h(row?.status     || 'New')}\n` +
    `Remarks     ${h(row?.remarks    || '—')}\n\n` +
    `📊 ${b('Signal Log #' + signalId)}\n\n` +
    `Type        ${h(sig?.signal_type      || '—')}\n` +
    `Impact      ${h(sig?.impact           || '—')}\n` +
    `Temp Fix    ${h(sig?.temporary_fix    || '—')}\n` +
    `Root Cause  ${h(sig?.root_cause_guess || '—')}\n` +
    `Kaizen      ${h(sig?.kaizen_ideas     || '—')}\n` +
    `Resolved    ${h(sig?.resolved         || '—')}`
  );
}
