import * as fs from 'fs';
import * as path from 'path';

/*
 * Claude Code appends every API error to the session transcript (~/.claude/projects/<project>/<session>.jsonl).
 * A usage-limit hit looks like:
 *   {"type":"assistant","error":"rate_limit","isApiErrorMessage":true,"apiErrorStatus":429,
 *    "message":{"content":[{"type":"text","text":"You've hit your session limit · resets 9:40pm"}]}, ...}
 * Watching for these lets ClaudeSwitch react within seconds instead of waiting for the next usage poll.
 */

export interface LimitEvent {
  text: string;
  /** True when the message says a usage limit was reached (not just transient throttling). */
  hardLimit: boolean;
  timestamp: number;
  file: string;
}

const HARD_LIMIT_RE = /hit your|reached your|usage limit|out of (?:extra )?usage|limit reached|limit will reset|resets? (?:at )?\d/i;
const MAX_AGE_MS = 5 * 60_000;
const TAIL_BYTES = 64 * 1024;

/** Parse one transcript line; returns an event if it's a rate-limit error. Exported for tests. */
export function parseLimitLine(line: string, file: string, now: number): LimitEvent | undefined {
  if (!line.includes('rate_limit') && !line.includes('"apiErrorStatus":429')) {
    return undefined;
  }
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (entry?.error !== 'rate_limit' && entry?.apiErrorStatus !== 429) {
    return undefined;
  }
  const timestamp = Date.parse(entry.timestamp ?? '') || now;
  if (now - timestamp > MAX_AGE_MS) {
    return undefined;
  }
  const content = entry?.message?.content;
  const text: string = Array.isArray(content)
    ? content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join(' ').trim()
    : typeof content === 'string'
      ? content
      : '';
  return { text, hardLimit: HARD_LIMIT_RE.test(text), timestamp, file };
}

export class TranscriptWatcher {
  private watcher?: fs.FSWatcher;
  private readonly offsets = new Map<string, number>();
  private readonly partial = new Map<string, string>();
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly projectsDir: string,
    private readonly onLimit: (e: LimitEvent) => void,
    private readonly log: (msg: string) => void,
  ) {}

  start(): void {
    if (this.watcher) {
      return;
    }
    try {
      fs.mkdirSync(this.projectsDir, { recursive: true });
      this.watcher = fs.watch(this.projectsDir, { recursive: true }, (_event, filename) => {
        if (typeof filename === 'string' && filename.endsWith('.jsonl')) {
          this.schedule(path.join(this.projectsDir, filename));
        }
      });
      this.watcher.on('error', (err) => this.log(`Transcript watcher error: ${err.message}`));
    } catch (err: any) {
      this.log(`Transcript watching unavailable (${err?.message ?? err}); relying on usage polling.`);
    }
  }

  private schedule(file: string): void {
    clearTimeout(this.pending.get(file));
    this.pending.set(
      file,
      setTimeout(() => {
        this.pending.delete(file);
        void this.scan(file);
      }, 300),
    );
  }

  private async scan(file: string): Promise<void> {
    let size: number;
    try {
      size = (await fs.promises.stat(file)).size;
    } catch {
      this.offsets.delete(file);
      this.partial.delete(file);
      return;
    }
    let offset = this.offsets.get(file);
    if (offset === undefined || offset > size) {
      // First time we see this file: only look at its tail; old errors are filtered by timestamp.
      offset = Math.max(0, size - TAIL_BYTES);
      this.partial.delete(file);
    }
    if (size === offset) {
      this.offsets.set(file, size);
      return;
    }
    let chunk: string;
    const fh = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      await fh.read(buf, 0, buf.length, offset);
      chunk = buf.toString('utf8');
    } finally {
      await fh.close();
    }
    this.offsets.set(file, size);
    const text = (this.partial.get(file) ?? '') + chunk;
    const lines = text.split('\n');
    this.partial.set(file, lines.pop() ?? '');
    const now = Date.now();
    for (const line of lines) {
      const event = parseLimitLine(line, file, now);
      if (event) {
        this.onLimit(event);
      }
    }
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = undefined;
    for (const t of this.pending.values()) {
      clearTimeout(t);
    }
    this.pending.clear();
  }
}
