import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentPercent, headline, normalizeUsage } from '../usage';
import { parseLimitLine } from '../transcripts';

// Trimmed copy of a real /api/oauth/usage response.
const REAL_RESPONSE = {
  five_hour: { utilization: 2.0, resets_at: '2026-11-18T00:09:59.993817+00:00', locked_reason: null },
  seven_day: { utilization: 31.0, resets_at: '2026-11-20T09:59:59.993841+00:00', locked_reason: null },
  seven_day_opus: null,
  limits: [
    { kind: 'session', group: 'session', percent: 2, severity: 'normal', resets_at: '2026-11-18T00:09:59.993817+00:00', scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 31, severity: 'normal', resets_at: '2026-11-20T09:59:59.993841+00:00', scope: null, is_active: true },
  ],
};

test('normalizes the limits array', () => {
  const s = normalizeUsage(REAL_RESPONSE, 1, 'api');
  assert.equal(s.windows.length, 2);
  assert.deepEqual(
    s.windows.map((w) => [w.key, w.group, w.label, w.percent]),
    [
      ['session', 'session', 'Session (5h)', 2],
      ['weekly_all', 'weekly', 'Weekly', 31],
    ],
  );
  assert.equal(s.windows[1].resetsAt, Date.parse('2026-11-20T09:59:59.993841+00:00'));
});

test('falls back to five_hour/seven_day fields, and a locked window counts as full', () => {
  const s = normalizeUsage(
    {
      five_hour: { utilization: 40, resets_at: null },
      seven_day: { utilization: 10, resets_at: '2026-11-20T10:00:00Z', locked_reason: 'limit' },
      seven_day_opus: { utilization: 55, resets_at: '2026-11-20T10:00:00Z' },
    },
    1,
    'api',
  );
  assert.deepEqual(
    s.windows.map((w) => [w.key, w.percent, w.resetsAt === undefined]),
    [
      ['five_hour', 40, true],
      ['seven_day', 100, false],
      ['seven_day_opus', 55, false],
    ],
  );
  assert.equal(s.windows[2].label, 'Weekly · Opus');
});

test('model-scoped weekly limits get readable labels', () => {
  const s = normalizeUsage({ limits: [{ kind: 'weekly_opus', group: 'weekly', percent: 70, resets_at: null, scope: null }] }, 1, 'api');
  assert.equal(s.windows[0].label, 'Weekly · Opus');
});

test('a window whose reset time has passed reads as 0%', () => {
  const w = { key: 'session', group: 'session' as const, label: 'x', percent: 99, resetsAt: 1000 };
  assert.equal(currentPercent(w, 999), 99);
  assert.equal(currentPercent(w, 1000), 0);
  const h = headline({ fetchedAt: 0, source: 'api', windows: [w] }, 2000);
  assert.equal(h.session?.current, 0);
});

test('detects a usage-limit error line from a transcript', () => {
  const now = Date.parse('2026-10-13T12:43:00.000Z');
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-13T12:42:45.162Z',
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    message: { content: [{ type: 'text', text: "You've hit your session limit · resets 9:40pm (Asia/Dhaka)" }] },
  });
  const e = parseLimitLine(line, 'f.jsonl', now);
  assert.ok(e);
  assert.equal(e.hardLimit, true);
  assert.match(e.text, /session limit/);
});

test('transient throttling is not treated as a hard limit', () => {
  const now = Date.now();
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: new Date(now).toISOString(),
    error: 'rate_limit',
    apiErrorStatus: 429,
    message: { content: [{ type: 'text', text: 'Request was rate limited. Retrying.' }] },
  });
  assert.equal(parseLimitLine(line, 'f', now)?.hardLimit, false);
});

test('ignores old errors and unrelated lines', () => {
  const now = Date.parse('2026-10-13T13:00:00.000Z');
  const old = JSON.stringify({ timestamp: '2026-10-13T12:42:45.162Z', error: 'rate_limit', apiErrorStatus: 429 });
  assert.equal(parseLimitLine(old, 'f', now), undefined);
  assert.equal(parseLimitLine('{"type":"user","message":"hello"}', 'f', now), undefined);
  assert.equal(parseLimitLine('not json rate_limit', 'f', now), undefined);
});
