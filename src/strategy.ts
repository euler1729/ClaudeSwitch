import { formatDuration, pct } from './format';
import { UsageSnapshot } from './types';
import { currentPercent } from './usage';

/*
 * Pure account-selection logic (no VS Code imports, unit-tested).
 *
 * Why "efficient" is earliest-reset-first: each account's weekly allowance resets on its own
 * schedule, and whatever is unused at reset is gone. Spending from the account that resets
 * soonest is the order that wastes the least. Switching has a cost too — the prompt cache is
 * per account, so the first request after a switch re-sends the whole conversation uncached —
 * so the strategy stays put unless an account is exhausted or a large amount of capacity is
 * about to expire.
 */

export type StrategyName = 'efficient' | 'balanced' | 'sequential' | 'manual';

export interface StrategyConfig {
  strategy: StrategyName;
  /** Percent of any window at which an account counts as exhausted. */
  switchThreshold: number;
  proactiveSwitching: boolean;
  proactiveHorizonHours: number;
  proactiveMinHeadroom: number;
  balanceMargin: number;
  minMinutesBetweenSwitches: number;
}

export interface CandidateInput {
  id: string;
  label: string;
  /** Allowed to be picked automatically. */
  enabled: boolean;
  /** Has stored credentials that still work. */
  usable: boolean;
  priority: number;
  usage?: UsageSnapshot;
  /** Set when Claude Code reported a hard usage-limit error for this account. */
  limitedUntil?: number;
}

export interface AccountState extends CandidateInput {
  maxPercent: number;
  sessionPercent: number;
  weeklyPercent: number;
  /** When the current weekly window ends (undefined if no weekly window is running). */
  weeklyResetsAt?: number;
  exhausted: boolean;
  exhaustedBy?: string;
  /** When an exhausted account becomes usable again, if known. */
  availableAt?: number;
  /** Percentage points left before the switch threshold, on the tightest window. */
  headroom: number;
}

export type Decision =
  | { kind: 'stay'; reason: string }
  | { kind: 'switch'; to: string; reason: string; urgent: boolean }
  | { kind: 'exhausted'; reason: string; nextAvailable?: { id: string; at: number } };

export interface DecisionInput {
  accounts: CandidateInput[];
  activeId?: string;
  now: number;
  lastSwitchAt?: number;
  config: StrategyConfig;
}

const WEEK_MS = 7 * 24 * 3600_000;
/** Accounts with less headroom than this are only used when nothing better is available. */
export const MIN_USEFUL_HEADROOM = 10;

export function evaluateAccount(c: CandidateInput, threshold: number, now: number): AccountState {
  let maxPercent = 0;
  let sessionPercent = 0;
  let weeklyPercent = 0;
  let weeklyResetsAt: number | undefined;
  let exhausted = false;
  let exhaustedBy: string | undefined;
  let exhaustedByPercent = -1;
  let availableAt: number | undefined;
  let availabilityUnknown = false;

  for (const w of c.usage?.windows ?? []) {
    const p = currentPercent(w, now);
    const running = w.resetsAt !== undefined && w.resetsAt > now;
    maxPercent = Math.max(maxPercent, p);
    if (w.group === 'session') {
      sessionPercent = Math.max(sessionPercent, p);
    } else if (w.group === 'weekly') {
      weeklyPercent = Math.max(weeklyPercent, p);
      if (running) {
        weeklyResetsAt = weeklyResetsAt === undefined ? w.resetsAt : Math.min(weeklyResetsAt, w.resetsAt!);
      }
    }
    if (p >= threshold) {
      exhausted = true;
      if (p > exhaustedByPercent) {
        exhaustedBy = w.label;
        exhaustedByPercent = p;
      }
      if (w.resetsAt === undefined) {
        availabilityUnknown = true;
      } else {
        availableAt = Math.max(availableAt ?? 0, w.resetsAt);
      }
    }
  }

  if (c.limitedUntil !== undefined && c.limitedUntil > now) {
    exhausted = true;
    exhaustedBy = exhaustedBy ?? 'usage';
    availableAt = Math.max(availableAt ?? 0, c.limitedUntil);
  }

  return {
    ...c,
    maxPercent,
    sessionPercent,
    weeklyPercent,
    weeklyResetsAt,
    exhausted,
    exhaustedBy,
    availableAt: availabilityUnknown ? undefined : availableAt,
    headroom: threshold - maxPercent,
  };
}

function deadline(s: AccountState, now: number): number {
  // An account with no running weekly window would start a fresh 7-day window when used.
  return s.weeklyResetsAt ?? now + WEEK_MS;
}

/** Usable accounts in the order the strategy would prefer them. */
export function rankCandidates(states: AccountState[], strategy: StrategyName, now: number): AccountState[] {
  const byStrategy: Record<StrategyName, (a: AccountState, b: AccountState) => number> = {
    efficient: (a, b) => deadline(a, now) - deadline(b, now) || a.maxPercent - b.maxPercent || a.priority - b.priority,
    balanced: (a, b) => a.weeklyPercent - b.weeklyPercent || a.sessionPercent - b.sessionPercent || a.priority - b.priority,
    sequential: (a, b) => a.priority - b.priority,
    manual: (a, b) => deadline(a, now) - deadline(b, now) || a.maxPercent - b.maxPercent || a.priority - b.priority,
  };
  const tiny = (s: AccountState) => (s.headroom < MIN_USEFUL_HEADROOM ? 1 : 0);
  const cmp = byStrategy[strategy];
  return states
    .filter((s) => s.enabled && s.usable && !s.exhausted)
    .sort((a, b) => tiny(a) - tiny(b) || cmp(a, b));
}

export function decide(input: DecisionInput): Decision {
  const { config, now } = input;
  const states = input.accounts.map((a) => evaluateAccount(a, config.switchThreshold, now));
  const active = states.find((s) => s.id === input.activeId);
  if (!active) {
    return { kind: 'stay', reason: 'The current Claude login is not managed by ClaudeSwitch.' };
  }

  const others = rankCandidates(states, config.strategy, now).filter((s) => s.id !== active.id);

  if (active.exhausted) {
    if (others.length > 0) {
      return {
        kind: 'switch',
        to: others[0].id,
        urgent: true,
        reason: `${active.label} reached its ${active.exhaustedBy ?? 'usage'} limit`,
      };
    }
    const next = states
      .filter((s) => s.usable && (s.enabled || s.id === active.id) && s.availableAt !== undefined)
      .sort((a, b) => a.availableAt! - b.availableAt!)[0];
    return {
      kind: 'exhausted',
      reason: 'Every account is at its limit.',
      nextAvailable: next ? { id: next.id, at: next.availableAt! } : undefined,
    };
  }

  if (config.strategy === 'manual') {
    return { kind: 'stay', reason: 'Manual strategy.' };
  }
  if (others.length === 0) {
    return { kind: 'stay', reason: 'No other account is available.' };
  }
  if (input.lastSwitchAt !== undefined && now - input.lastSwitchAt < config.minMinutesBetweenSwitches * 60_000) {
    return { kind: 'stay', reason: 'Switched recently.' };
  }

  switch (config.strategy) {
    case 'efficient': {
      if (!config.proactiveSwitching) {
        return { kind: 'stay', reason: 'Proactive switching is off.' };
      }
      const horizon = now + config.proactiveHorizonHours * 3600_000;
      const activeDeadline = deadline(active, now);
      for (const s of others) {
        if (s.weeklyResetsAt === undefined || s.weeklyResetsAt > horizon || s.weeklyResetsAt >= activeDeadline) {
          continue;
        }
        const weeklyLeft = config.switchThreshold - s.weeklyPercent;
        if (weeklyLeft < config.proactiveMinHeadroom || s.headroom < MIN_USEFUL_HEADROOM) {
          continue;
        }
        return {
          kind: 'switch',
          to: s.id,
          urgent: false,
          reason: `${s.label} has ${pct(weeklyLeft)} of its weekly limit left, which expires in ${formatDuration(s.weeklyResetsAt - now)}`,
        };
      }
      return { kind: 'stay', reason: 'No capacity is about to expire on another account.' };
    }
    case 'balanced': {
      const best = others[0];
      const gap = active.weeklyPercent - best.weeklyPercent;
      if (gap >= config.balanceMargin && best.headroom >= MIN_USEFUL_HEADROOM) {
        return {
          kind: 'switch',
          to: best.id,
          urgent: false,
          reason: `balancing usage: ${active.label} is at ${pct(active.weeklyPercent)} weekly, ${best.label} at ${pct(best.weeklyPercent)}`,
        };
      }
      return { kind: 'stay', reason: 'Accounts are balanced within the margin.' };
    }
    case 'sequential': {
      const best = others[0];
      if (best.priority < active.priority && best.headroom >= MIN_USEFUL_HEADROOM) {
        return {
          kind: 'switch',
          to: best.id,
          urgent: false,
          reason: `${best.label} is available again and comes first in your order`,
        };
      }
      return { kind: 'stay', reason: 'Already on the first available account.' };
    }
  }
}
