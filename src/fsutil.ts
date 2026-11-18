import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

/** Write via a temp file + rename so readers never see a half-written file. */
export async function writeFileAtomic(file: string, content: string, mode?: number): Promise<void> {
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true });
  let finalMode = mode;
  if (finalMode === undefined) {
    try {
      finalMode = (await fs.promises.stat(file)).mode & 0o777;
    } catch {
      finalMode = 0o600;
    }
  }
  const tmp = path.join(dir, `.${path.basename(file)}.claudeswitch-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.promises.writeFile(tmp, content, { encoding: 'utf8', mode: finalMode });
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8')) as T;
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

/** Serialises async work so concurrent callers don't interleave. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
