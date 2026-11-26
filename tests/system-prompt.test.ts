import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../lib/agent/system-prompt';

describe('buildSystemPrompt', () => {
  const p = buildSystemPrompt('', new Date('2026-11-25T12:00:00Z'));

  it('covers the investigation loop, search rules, untrusted data and the report', () => {
    for (const s of ['suggested_window', 'change_request', 'hypothesis', 'tstats', 'TERM(', 'at most 2', '<untrusted source=', 'Draft work note', 'Confidence'.toLowerCase()]) {
      expect(p.toLowerCase()).toContain(s.toLowerCase());
    }
    expect(p).toContain("Today's date: 2026-11-25");
  });

  it('appends the user instructions only when given', () => {
    expect(p).not.toContain('Additional instructions');
    expect(buildSystemPrompt('  index=app_prod  ')).toContain('# Additional instructions from the user\nindex=app_prod');
  });
});
