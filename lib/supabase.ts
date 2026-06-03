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
    .not('status', 'in', '("Completed","Closed")')
    .order('created_at', { ascending: false })
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
