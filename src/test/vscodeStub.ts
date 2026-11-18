/* Minimal stand-in for the `vscode` module so the controller can run under plain Node in tests. */

export const messages: Array<[string, string]> = [];
export const settings: Record<string, unknown> = {};

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly event = (fn: (e: T) => void) => {
    this.listeners.push(fn);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== fn)) };
  };
  fire(e?: T): void {
    for (const l of [...this.listeners]) {
      l(e as T);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

const notify = (kind: string) => async (message: string) => {
  messages.push([kind, message]);
  return undefined;
};

export const window = {
  showInformationMessage: notify('info'),
  showWarningMessage: notify('warning'),
  showErrorMessage: notify('error'),
};

export const workspace = {
  getConfiguration: () => ({
    get: (key: string, fallback: unknown) => (key in settings ? settings[key] : fallback),
    update: async (key: string, value: unknown) => {
      settings[key] = value;
    },
  }),
  onDidChangeConfiguration: () => ({ dispose() {} }),
};

export const ConfigurationTarget = { Global: 1 };

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class MemorySecrets {
  readonly data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key);
  }
  async store(key: string, value: string) {
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
}
