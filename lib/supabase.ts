import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export interface Request {
  id: number;
  requestor: string;
  request_text: string;
  priority: string | null;
  complexity: string | null;
  status: string;
  remarks: string | null;
  requested_date: string;
  completed_date: string | null;
  reminded_at: string | null;
  chat_id: number;
  created_at: string;
}

export async function appendRequest(
  requestor: string,
  requestText: string,
  chatId: number
): Promise<number> {
  const { data, error } = await supabase
    .from('requests')
    .insert({ requestor, request_text: requestText, chat_id: chatId })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function updateField(
  rowId: number,
  column: string,
  value: string
): Promise<void> {
  const patch: Record<string, string | null> = { [column]: value };
  if (column === 'status') {
    patch.completed_date = value === 'Completed' ? new Date().toISOString() : null;
  }
  const { error } = await supabase.from('requests').update(patch).eq('id', rowId);
  if (error) throw error;
}

export async function getRow(rowId: number): Promise<Request | null> {
  const { data } = await supabase
    .from('requests')
    .select('*')
    .eq('id', rowId)
    .single();
  return data ?? null;
}

export async function getPendingRequests(): Promise<Request[]> {
  const { data, error } = await supabase
    .from('requests')
    .select('*')
    .not('status', 'in', '("Completed","Closed","Done")')
    .order('id', { ascending: true })
    .limit(10);
  if (error) throw error;
  return data ?? [];
}

export async function getAllRequests(): Promise<Request[]> {
  const { data, error } = await supabase
    .from('requests')
    .select('*')
    .order('id', { ascending: true })
    .limit(10);
  if (error) throw error;
  return data ?? [];
}

export async function getRecentRequestors(): Promise<string[]> {
  const { data } = await supabase
    .from('requests')
    .select('requestor')
    .order('created_at', { ascending: false })
    .limit(25);
  const names = (data ?? []).map((r) => r.requestor as string);
  return [...new Set(names)].slice(0, 5);
}

// Returns open requests whose SLA has been breached and haven't been reminded recently
export async function getOverdueRequests(): Promise<Request[]> {
  const now = new Date();

  // Thresholds in hours per priority
  const thresholds: Record<string, number> = {
    Urgent: 4,
    High: 24,
    Med: 120, // 5 days
  };

  const results: Request[] = [];

  for (const [priority, hours] of Object.entries(thresholds)) {
    const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('requests')
      .select('*')
      .eq('priority', priority)
      .not('status', 'in', '("Completed","Closed")')
      .lt('created_at', cutoff)
      .or(`reminded_at.is.null,reminded_at.lt.${cutoff}`);
    if (data) results.push(...data);
  }

  return results;
}

export async function markReminded(rowId: number): Promise<void> {
  await supabase
    .from('requests')
    .update({ reminded_at: new Date().toISOString() })
    .eq('id', rowId);
}

// ── Signal Logs ────────────────────────────────────────────────

export interface SignalLog {
  id: number;
  date_logged: string;
  what_happened: string;
  logged_by: string;
  request_id: number | null;
  signal_type: string | null;
  impact: string | null;
  temporary_fix: string | null;
  root_cause_guess: string | null;
  kaizen_ideas: string | null;
  resolved: string | null;
  chat_id: number;
  created_at: string;
}

export async function appendSignalLog(
  whatHappened: string,
  loggedBy: string,
  chatId: number,
  requestId?: number
): Promise<number> {
  const { data, error } = await supabase
    .from('signal_logs')
    .insert({ what_happened: whatHappened, logged_by: loggedBy || process.env.LOGGED_BY_NAME || 'Cheryl', chat_id: chatId, request_id: requestId ?? null })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function updateSignalField(
  signalId: number,
  column: string,
  value: string
): Promise<void> {
  const { error } = await supabase
    .from('signal_logs')
    .update({ [column]: value })
    .eq('id', signalId);
  if (error) throw error;
}

export async function getSignalRow(signalId: number): Promise<SignalLog | null> {
  const { data } = await supabase
    .from('signal_logs')
    .select('*')
    .eq('id', signalId)
    .single();
  return data ?? null;
}

// ── State ──────────────────────────────────────────────────────

export async function deleteRequest(rowId: number): Promise<void> {
  await supabase.from('requests').delete().eq('id', rowId);
}

export async function getState(chatId: number): Promise<string | null> {
  const { data } = await supabase
    .from('bot_state')
    .select('state_json')
    .eq('chat_id', chatId)
    .single();
  return data?.state_json ?? null;
}

export async function setState(chatId: number, stateJson: string): Promise<void> {
  await supabase
    .from('bot_state')
    .upsert({ chat_id: chatId, state_json: stateJson, updated_at: new Date().toISOString() });
}

export async function clearState(chatId: number): Promise<void> {
  await supabase
    .from('bot_state')
    .update({ state_json: null })
    .eq('chat_id', chatId);
}
