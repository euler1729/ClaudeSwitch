/* Small pure formatting helpers shared by the strategy and the UI. */

export function formatDuration(ms: number): string {
  if (ms <= 0) {
    return 'now';
  }
  const totalMinutes = Math.max(1, Math.round(ms / 60_000));
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) {
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

/** "15:40" for today-ish times, "Thu 10:00" for anything more than a day away. */
export function formatClock(t: number, now: number): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (Math.abs(t - now) < 20 * 3600_000) {
    return time;
  }
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

export function percentBar(percent: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function pct(n: number): string {
  return `${Math.round(n)}%`;
}
