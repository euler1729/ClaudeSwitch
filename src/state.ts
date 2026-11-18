import * as fs from 'fs';
import * as vscode from 'vscode';
import { Mutex, writeFileAtomic } from './fsutil';
import { AccountMeta, CredentialsBlob, SwitchRecord, UsageSnapshot } from './types';

/*
 * Non-secret state lives in one JSON file in the extension's global storage so every VS Code
 * window sees the same accounts, usage and switch history (globalState isn't reliably shared
 * live between windows). Tokens live in SecretStorage (the OS keychain).
 */

export interface StateData {
  version: 1;
  accounts: AccountMeta[];
  usage: Record<string, UsageSnapshot>;
  /** Accounts Claude Code reported as hard-limited, with when that ends. */
  limitedUntil: Record<string, number>;
  activeId?: string;
  lastSwitch?: SwitchRecord;
}

function emptyState(): StateData {
  return { version: 1, accounts: [], usage: {}, limitedUntil: {} };
}

export class SharedState implements vscode.Disposable {
  private data: StateData = emptyState();
  private lastText?: string;
  private readonly mutex = new Mutex();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private watching = false;
  private readonly listener = () => void this.reloadFromDisk(false);

  constructor(private readonly file: string) {}

  get current(): Readonly<StateData> {
    return this.data;
  }

  accounts(): AccountMeta[] {
    return [...this.data.accounts].sort((a, b) => a.priority - b.priority);
  }

  account(id: string | undefined): AccountMeta | undefined {
    return id ? this.data.accounts.find((a) => a.id === id) : undefined;
  }

  async load(): Promise<void> {
    await this.reloadFromDisk(true);
    if (!this.watching) {
      this.watching = true;
      fs.watchFile(this.file, { interval: 1500 }, this.listener);
    }
  }

  /** Read-modify-write against the latest copy on disk. */
  update(mutator: (d: StateData) => void): Promise<void> {
    return this.mutex.run(async () => {
      const d = (await this.readDisk()) ?? emptyState();
      mutator(d);
      const text = JSON.stringify(d, null, 2);
      await writeFileAtomic(this.file, text, 0o600);
      this.lastText = text;
      this.data = d;
      this.emitter.fire();
    });
  }

  private async readDisk(): Promise<StateData | undefined> {
    try {
      const text = await fs.promises.readFile(this.file, 'utf8');
      const d = JSON.parse(text) as StateData;
      if (d?.version !== 1 || !Array.isArray(d.accounts)) {
        return undefined;
      }
      d.usage ??= {};
      d.limitedUntil ??= {};
      return d;
    } catch {
      return undefined;
    }
  }

  private async reloadFromDisk(initial: boolean): Promise<void> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.file, 'utf8');
    } catch {
      if (initial) {
        this.data = emptyState();
        this.emitter.fire();
      }
      return;
    }
    if (text === this.lastText) {
      return;
    }
    const d = await this.readDisk();
    if (d) {
      this.lastText = text;
      this.data = d;
      this.emitter.fire();
    }
  }

  dispose(): void {
    fs.unwatchFile(this.file, this.listener);
    this.emitter.dispose();
  }
}

/** Per-account tokens in VS Code SecretStorage. */
export class CredentialVault {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private key(id: string): string {
    return `claudeswitch.credentials.${id}`;
  }

  async get(id: string): Promise<CredentialsBlob | undefined> {
    const raw = await this.secrets.get(this.key(id));
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as CredentialsBlob;
    } catch {
      return undefined;
    }
  }

  set(id: string, blob: CredentialsBlob): Thenable<void> {
    return this.secrets.store(this.key(id), JSON.stringify(blob));
  }

  delete(id: string): Thenable<void> {
    return this.secrets.delete(this.key(id));
  }
}
