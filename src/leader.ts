import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { writeFileAtomic } from './fsutil';

/*
 * With several VS Code windows open, exactly one should poll usage, refresh inactive tokens and
 * switch automatically. Two windows refreshing the same token at once would invalidate it.
 * Election is a heartbeat file: the holder renews it; anyone may take over a stale or dead one.
 */

interface LeaseFile {
  id: string;
  pid: number;
  heartbeat: number;
}

const HEARTBEAT_MS = 10_000;
const STALE_MS = 35_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

export class LeaderLease {
  private readonly id = randomUUID();
  private timer?: NodeJS.Timeout;
  private leader = false;

  constructor(private readonly file: string, private readonly onChange: (isLeader: boolean) => void) {}

  get isLeader(): boolean {
    return this.leader;
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), HEARTBEAT_MS);
  }

  private async read(): Promise<LeaseFile | undefined> {
    try {
      return JSON.parse(await fs.promises.readFile(this.file, 'utf8')) as LeaseFile;
    } catch {
      return undefined;
    }
  }

  private async tick(): Promise<void> {
    let isLeader = false;
    try {
      const lease = await this.read();
      const now = Date.now();
      const free =
        !lease ||
        lease.id === this.id ||
        now - lease.heartbeat > STALE_MS ||
        (lease.pid !== process.pid && !pidAlive(lease.pid));
      if (free) {
        await writeFileAtomic(this.file, JSON.stringify({ id: this.id, pid: process.pid, heartbeat: now }), 0o600);
        // Another window may have written at the same moment; whoever's write landed last wins.
        await new Promise((r) => setTimeout(r, 150));
        isLeader = (await this.read())?.id === this.id;
      }
    } catch {
      isLeader = false;
    }
    if (isLeader !== this.leader) {
      this.leader = isLeader;
      this.onChange(isLeader);
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    if (this.leader) {
      try {
        const lease = JSON.parse(fs.readFileSync(this.file, 'utf8')) as LeaseFile;
        if (lease.id === this.id) {
          fs.rmSync(this.file, { force: true });
        }
      } catch {
        // ignore
      }
    }
  }
}
