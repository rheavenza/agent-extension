/**
 * Keeps the model's context small over long investigations.
 *
 * Every Splunk search can return tens of thousands of characters, and the whole history is sent
 * again on every step. Only the most recent results need to be read in full; older ones are cut
 * down to their metadata and a few sample rows. The model can page a still-live job back in with
 * splunk_get_results.
 *
 * This only changes what the model sees on each step (through prepareStep). The chat history the
 * user sees, and that is saved, keeps the full results. The trimming is deterministic, so a result
 * that was trimmed once looks the same on every later step and stays in the prompt cache.
 */

/** Tool results that can be trimmed once they are no longer recent. */
const PRUNABLE = new Set(['splunk_search', 'splunk_get_results', 'read_page_text']);

export interface PruneOptions {
  /** How many of the most recent prunable results to keep in full. */
  keepRecent?: number;
  /** Results smaller than this (as JSON) are never trimmed. */
  minChars?: number;
  /** Sample rows kept from a trimmed Splunk result. */
  sampleRows?: number;
}

const NOTE =
  'Older result trimmed to save context. The findings you already wrote down still stand. ' +
  'Use splunk_get_results with this sid to read more rows while the job is still available, or run the search again.';

type Json = Record<string, any>;

export function summarizeToolOutput(toolName: string, value: Json, sampleRows = 3): Json {
  if (toolName === 'read_page_text') {
    const text = String(value.text ?? '');
    return {
      title: value.title,
      url: value.url,
      text: text.slice(0, 1000) + (text.length > 1000 ? ' …[trimmed]' : ''),
      trimmed: true,
      note: 'Older page read trimmed to save context. Call read_page_text again if you need the full text.',
    };
  }
  const { results, ...meta } = value;
  return {
    ...meta,
    results: Array.isArray(results) ? results.slice(0, sampleRows) : undefined,
    trimmed: true,
    note: NOTE,
  };
}

/**
 * Returns the messages with older large tool results trimmed, or the same array when nothing
 * needs trimming. Messages are never mutated.
 */
export function pruneToolResults<M>(messages: M[], opts: PruneOptions = {}): M[] {
  const { keepRecent = 3, minChars = 4000, sampleRows = 3 } = opts;

  // Locate every prunable tool result, newest last.
  const found: Array<{ m: number; p: number }> = [];
  messages.forEach((msg: any, m) => {
    if (msg?.role !== 'tool' || !Array.isArray(msg.content)) return;
    msg.content.forEach((part: any, p: number) => {
      if (part?.type === 'tool-result' && PRUNABLE.has(part.toolName) && part.output?.type === 'json') {
        found.push({ m, p });
      }
    });
  });
  const old = found.slice(0, Math.max(0, found.length - keepRecent));
  if (!old.length) return messages;

  let out: M[] | null = null;
  for (const { m, p } of old) {
    const msg = (out ?? messages)[m] as any;
    const part = msg.content[p];
    const value = part.output.value;
    if (!value || typeof value !== 'object' || value.trimmed) continue;
    if (JSON.stringify(value).length < minChars) continue;
    out ??= [...messages];
    const content = [...msg.content];
    content[p] = { ...part, output: { type: 'json', value: summarizeToolOutput(part.toolName, value, sampleRows) } };
    out[m] = { ...msg, content } as M;
  }
  return out ?? messages;
}
