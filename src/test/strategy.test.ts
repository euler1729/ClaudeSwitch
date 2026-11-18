import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CandidateInput, StrategyConfig, decide, evaluateAccount, rankCandidates } from '../strategy';
import { UsageSnapshot } from '../types';

const H = 3600_000;
const NOW = Date.parse('2026-11-18T12:00:00Z');

const CONFIG: StrategyConfig = {
  strategy: 'efficient',
  switchThreshold: 95,
  proactiveSwitching: true,
  proactiveHorizonHours: 24,
  proactiveMinHeadroom: 25,
  balanceMargin: 20,
  minMinutesBetweenSwitches: 30,
};

function usage(session: number, weekly: number, weeklyResetsInH?: number, sessionResetsInH = 3): UsageSnapshot {
  return {
    fetchedAt: NOW,
    source: 'api',
    windows: [
      { key: 'session', group: 'session', label: 'Session (5h)', percent: session, resetsAt: NOW + sessionResetsInH * H },
      {
        key: 'weekly_all',
        group: 'weekly',
        label: 'Weekly',
        percent: weekly,
        resetsAt: weeklyResetsInH === undefined ? undefined : NOW + weeklyResetsInH * H,
      },
    ],
  };
}

function acct(id: string, u: UsageSnapshot | undefined, extra: Partial<CandidateInput> = {}): CandidateInput {
  return { id, label: id, enabled: true, usable: true, priority: id.charCodeAt(0), usage: u, ...extra };
}

test('stays on a healthy account when nothing is about to expire', () => {
  const d = decide({
    accounts: [acct('a', usage(40, 50, 100)), acct('b', usage(0, 10, 120))],
    activeId: 'a',
    now: NOW,
    config: CONFIG,
  });
  assert.equal(d.kind, 'stay');
});

test('switches immediately when the active account hits the threshold, to the account that resets soonest', () => {
  const d = decide({
    accounts: [acct('a', usage(96, 50, 100)), acct('b', usage(0, 10, 150)), acct('c', usage(0, 60, 30))],
    activeId: 'a',
    now: NOW,
    lastSwitchAt: NOW - 60_000, // the min-interval rule doesn't block urgent switches
    config: CONFIG,
  });
  assert.equal(d.kind, 'switch');
  assert.equal(d.kind === 'switch' && d.to, 'c');
  assert.equal(d.kind === 'switch' && d.urgent, true);
  assert.match(d.kind === 'switch' ? d.reason : '', /Session \(5h\)/);
});

test('never picks exhausted, excluded or logged-out accounts', () => {
  const d = decide({
    accounts: [
      acct('a', usage(100, 50, 100)),
      acct('b', usage(0, 99, 5)),
      acct('c', usage(0, 0, 10), { enabled: false }),
      acct('d', usage(0, 0, 10), { usable: false }),
      acct('e', usage(0, 20, 160)),
    ],
    activeId: 'a',
    now: NOW,
    config: CONFIG,
  });
  assert.deepEqual(d.kind === 'switch' && d.to, 'e');
});

test('reports exhaustion with the earliest recovery time', () => {
  const d = decide({
    accounts: [acct('a', usage(100, 50, 100, 2)), acct('b', usage(97, 20, 100, 1)), acct('c', usage(10, 100, 30))],
    activeId: 'a',
    now: NOW,
    config: CONFIG,
  });
  assert.equal(d.kind, 'exhausted');
  assert.deepEqual(d.kind === 'exhausted' && d.nextAvailable, { id: 'b', at: NOW + 1 * H });
});

test('efficient: switches early to an account whose unused weekly capacity is about to expire', () => {
  const d = decide({
    accounts: [acct('a', usage(20, 30, 120)), acct('b', usage(0, 40, 10))],
    activeId: 'a',
    now: NOW,
    config: CONFIG,
  });
  assert.equal(d.kind, 'switch');
  assert.equal(d.kind === 'switch' && d.urgent, false);
  assert.match(d.kind === 'switch' ? d.reason : '', /55% of its weekly limit left, which expires in 10h/);
});

test('efficient: no early switch when little would be lost, when outside the horizon, or right after a switch', () => {
  const base = { activeId: 'a', now: NOW, config: CONFIG };
  // Only 15 points left on b.
  assert.equal(decide({ ...base, accounts: [acct('a', usage(20, 30, 120)), acct('b', usage(0, 80, 10))] }).kind, 'stay');
  // b resets in 48h, outside the 24h horizon.
  assert.equal(decide({ ...base, accounts: [acct('a', usage(20, 30, 120)), acct('b', usage(0, 10, 48))] }).kind, 'stay');
  // a resets before b.
  assert.equal(decide({ ...base, accounts: [acct('a', usage(20, 30, 5)), acct('b', usage(0, 10, 10))] }).kind, 'stay');
  // Switched 10 minutes ago.
  assert.equal(
    decide({ ...base, lastSwitchAt: NOW - 10 * 60_000, accounts: [acct('a', usage(20, 30, 120)), acct('b', usage(0, 40, 10))] }).kind,
    'stay',
  );
  // Proactive switching disabled.
  assert.equal(
    decide({ ...base, config: { ...CONFIG, proactiveSwitching: false }, accounts: [acct('a', usage(20, 30, 120)), acct('b', usage(0, 40, 10))] })
      .kind,
    'stay',
  );
});

test('efficient: an account with no running weekly window ranks after ones that will expire', () => {
  const states = [acct('a', usage(0, 0, undefined)), acct('b', usage(0, 50, 100))].map((c) => evaluateAccount(c, 95, NOW));
  assert.deepEqual(
    rankCandidates(states, 'efficient', NOW).map((s) => s.id),
    ['b', 'a'],
  );
});

test('accounts with almost no headroom are a last resort', () => {
  const states = [acct('a', usage(90, 10, 5)), acct('b', usage(0, 50, 100))].map((c) => evaluateAccount(c, 95, NOW));
  assert.deepEqual(
    rankCandidates(states, 'efficient', NOW).map((s) => s.id),
    ['b', 'a'],
  );
});

test('balanced: switches when the gap exceeds the margin', () => {
  const cfg = { ...CONFIG, strategy: 'balanced' as const };
  assert.equal(
    decide({ accounts: [acct('a', usage(10, 60, 100)), acct('b', usage(0, 30, 100))], activeId: 'a', now: NOW, config: cfg }).kind,
    'switch',
  );
  assert.equal(
    decide({ accounts: [acct('a', usage(10, 45, 100)), acct('b', usage(0, 30, 100))], activeId: 'a', now: NOW, config: cfg }).kind,
    'stay',
  );
});

test('sequential: uses list order and returns to a higher-priority account once it recovers', () => {
  const cfg = { ...CONFIG, strategy: 'sequential' as const };
  const exhausted = decide({
    accounts: [acct('a', usage(99, 10, 100)), acct('b', usage(0, 50, 2)), acct('c', usage(0, 0, 100))],
    activeId: 'a',
    now: NOW,
    config: cfg,
  });
  assert.equal(exhausted.kind === 'switch' && exhausted.to, 'b');

  const recovered = decide({
    accounts: [acct('a', usage(0, 10, 100)), acct('b', usage(0, 50, 100))],
    activeId: 'b',
    now: NOW,
    config: cfg,
  });
  assert.equal(recovered.kind === 'switch' && recovered.to, 'a');
});

test('manual: never switches on its own, but still flags an exhausted account', () => {
  const cfg = { ...CONFIG, strategy: 'manual' as const };
  assert.equal(
    decide({ accounts: [acct('a', usage(20, 30, 120)), acct('b', usage(0, 40, 10))], activeId: 'a', now: NOW, config: cfg }).kind,
    'stay',
  );
  const d = decide({ accounts: [acct('a', usage(99, 30, 120)), acct('b', usage(0, 40, 10))], activeId: 'a', now: NOW, config: cfg });
  assert.equal(d.kind === 'switch' && d.urgent, true);
});

test('a window that has reset no longer counts against the account', () => {
  const st = evaluateAccount(acct('a', usage(100, 30, 100, -0.5)), 95, NOW);
  assert.equal(st.exhausted, false);
  assert.equal(st.sessionPercent, 0);
});

test('a usage-limit error from Claude Code marks the account exhausted until it expires', () => {
  const limited = acct('a', usage(10, 10, 100), { limitedUntil: NOW + 15 * 60_000 });
  const st = evaluateAccount(limited, 95, NOW);
  assert.equal(st.exhausted, true);
  assert.equal(st.availableAt, NOW + 15 * 60_000);
  const d = decide({ accounts: [limited, acct('b', usage(0, 0, 100))], activeId: 'a', now: NOW, config: CONFIG });
  assert.equal(d.kind === 'switch' && d.to, 'b');
});

test('does nothing when the current login is not managed', () => {
  const d = decide({ accounts: [acct('a', usage(99, 99, 1))], activeId: undefined, now: NOW, config: CONFIG });
  assert.equal(d.kind, 'stay');
});
