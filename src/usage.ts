import { UsageSnapshot, UsageWindow, WindowGroup } from './types';

/* Pure helpers for Claude's `/api/oauth/usage` response. No VS Code imports so they can be unit-tested. */

const LEGACY_WINDOWS: Record<string, { group: WindowGroup; label: string }> = {
  five_hour: { group: 'session', label: 'Session (5h)' },
  seven_day: { group: 'weekly', label: 'Weekly' },
  seven_day_opus: { group: 'weekly', label: 'Weekly · Opus' },
  seven_day_sonnet: { group: 'weekly', label: 'Weekly · Sonnet' },
};

export function parseTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

function labelForLimit(kind: string, group: WindowGroup, scope: unknown): string {
  let base: string;
  if (kind === 'session') {
    base = 'Session (5h)';
  } else if (kind === 'weekly_all') {
    base = 'Weekly';
  } else if (kind.startsWith('weekly_')) {
    const rest = kind.slice('weekly_'.length).replace(/_/g, ' ');
    base = `Weekly · ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
  } else {
    base = kind.replace(/_/g, ' ');
    base = base.charAt(0).toUpperCase() + base.slice(1);
    if (group === 'weekly' && !/week/i.test(base)) {
      base = `Weekly · ${base}`;
    }
  }
  return typeof scope === 'string' && scope ? `${base} (${scope})` : base;
}

function groupOf(value: unknown, kind: string): WindowGroup {
  if (value === 'session' || kind === 'session') {
    return 'session';
  }
  if (value === 'weekly' || kind.startsWith('weekly')) {
    return 'weekly';
  }
  return 'other';
}

/**
 * Turn a usage response into a list of limit windows. Prefers the newer `limits` array and falls
 * back to the `five_hour` / `seven_day*` fields.
 */
export function normalizeUsage(raw: unknown, fetchedAt: number, source: UsageSnapshot['source']): UsageSnapshot {
  const windows: UsageWindow[] = [];
  const data = (raw ?? {}) as Record<string, any>;

  if (Array.isArray(data.limits) && data.limits.length > 0) {
    for (const l of data.limits) {
      if (!l || typeof l.percent !== 'number' || typeof l.kind !== 'string') {
        continue;
      }
      const group = groupOf(l.group, l.kind);
      windows.push({
        key: l.scope ? `${l.kind}:${l.scope}` : l.kind,
        group,
        label: labelForLimit(l.kind, group, l.scope),
        percent: clampPercent(l.percent),
        resetsAt: parseTime(l.resets_at),
      });
    }
  }

  if (windows.length === 0) {
    for (const [key, info] of Object.entries(LEGACY_WINDOWS)) {
      const w = data[key];
      if (!w || typeof w !== 'object') {
        continue;
      }
      const locked = w.locked_reason !== null && w.locked_reason !== undefined;
      if (typeof w.utilization !== 'number' && !locked) {
        continue;
      }
      windows.push({
        key,
        group: info.group,
        label: info.label,
        percent: locked ? 100 : clampPercent(w.utilization),
        resetsAt: parseTime(w.resets_at),
      });
    }
  }

  return { fetchedAt, source, windows };
}

function clampPercent(p: number): number {
  if (!Number.isFinite(p)) {
    return 0;
  }
  return Math.max(0, Math.min(100, p));
}

/** Percent of a window as of `now`: a window whose reset time has passed is back to 0. */
export function currentPercent(w: UsageWindow, now: number): number {
  return w.resetsAt !== undefined && w.resetsAt <= now ? 0 : w.percent;
}

/** The headline session and weekly numbers for display. */
export function headline(snapshot: UsageSnapshot | undefined, now: number): {
  session?: UsageWindow & { current: number };
  weekly?: UsageWindow & { current: number };
} {
  if (!snapshot) {
    return {};
  }
  const pick = (group: WindowGroup) => {
    let best: (UsageWindow & { current: number }) | undefined;
    for (const w of snapshot.windows) {
      if (w.group !== group) {
        continue;
      }
      const current = currentPercent(w, now);
      if (!best || current > best.current) {
        best = { ...w, current };
      }
    }
    return best;
  };
  return { session: pick('session'), weekly: pick('weekly') };
}
