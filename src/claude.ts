import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { readJson, writeFileAtomic } from './fsutil';
import { CredentialsBlob } from './types';

/*
 * Where Claude Code keeps its login, and how to read/replace it.
 *  - Linux/Windows: <configDir>/.credentials.json (plain JSON, mode 0600)
 *  - macOS: the login keychain, generic password "Claude Code-credentials[-<hash>]"
 * Claude Code watches the credential store and reloads it on change, so replacing it switches
 * the account for new requests in running sessions too.
 */

export interface ClaudePaths {
  configDir: string;
  credentialsFile: string;
  globalConfigFile: string;
  projectsDir: string;
  useKeychain: boolean;
  keychainService: string;
  keychainAccount: string;
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function resolvePaths(configDirSetting: string): ClaudePaths {
  const explicit = configDirSetting.trim() || process.env.CLAUDE_CONFIG_DIR || '';
  const configDir = explicit ? path.resolve(expandHome(explicit)) : path.join(os.homedir(), '.claude');
  const globalConfigFile = explicit ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json');
  const hashSuffix = explicit
    ? `-${createHash('sha256').update(configDir.normalize('NFC')).digest('hex').substring(0, 8)}`
    : '';
  let keychainAccount: string;
  try {
    keychainAccount = process.env.USER || os.userInfo().username;
  } catch {
    keychainAccount = 'claude-code-user';
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(keychainAccount)) {
    keychainAccount = 'claude-code-user';
  }
  return {
    configDir,
    credentialsFile: path.join(configDir, '.credentials.json'),
    globalConfigFile,
    projectsDir: path.join(configDir, 'projects'),
    useKeychain: process.platform === 'darwin',
    keychainService: `Claude Code-credentials${hashSuffix}`,
    keychainAccount,
  };
}

/** Run a command without a shell; `input` is written to its stdin. Exported for tests. */
export function run(cmd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

/**
 * Longest command line `security -i` reads in one piece. It splits a longer line and still runs
 * the first part, which overwrites the Keychain item with a truncated value.
 */
export const SECURITY_MAX_LINE = 4095;

/** `security -i` command that stores the credentials, read from stdin. Exported for tests. */
export function keychainWriteCommand(p: ClaudePaths, json: string): string {
  const hex = Buffer.from(json, 'utf8').toString('hex');
  // Account and service names are restricted to safe characters in resolvePaths.
  const line = `add-generic-password -U -a "${p.keychainAccount}" -s "${p.keychainService}" -X "${hex}"`;
  if (line.length > SECURITY_MAX_LINE) {
    const limit = Math.floor((SECURITY_MAX_LINE - (line.length - hex.length)) / 2);
    throw new Error(
      `This login is too large to store in the macOS Keychain (${Buffer.byteLength(json, 'utf8')} bytes; the limit is ${limit}). ` +
        "Claude Code's current login was not changed.",
    );
  }
  return `${line}\n`;
}

function parseBlob(text: string): CredentialsBlob | undefined {
  let trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    trimmed = Buffer.from(trimmed, 'hex').toString('utf8');
  }
  const blob = JSON.parse(trimmed) as CredentialsBlob;
  if (!blob?.claudeAiOauth?.accessToken || !blob.claudeAiOauth.refreshToken) {
    return undefined;
  }
  return blob;
}

/** Current Claude Code login, or undefined when nobody is logged in with a subscription account. */
export async function readCredentials(p: ClaudePaths): Promise<CredentialsBlob | undefined> {
  if (p.useKeychain) {
    try {
      const out = await run('security', ['find-generic-password', '-a', p.keychainAccount, '-w', '-s', p.keychainService]);
      return parseBlob(out);
    } catch {
      // Not in the keychain: Claude Code falls back to the file in some setups.
    }
  }
  try {
    return parseBlob(await fs.promises.readFile(p.credentialsFile, 'utf8'));
  } catch {
    return undefined;
  }
}

export async function writeCredentials(p: ClaudePaths, blob: CredentialsBlob): Promise<void> {
  const json = JSON.stringify(blob);
  if (p.useKeychain) {
    // Send the command on stdin (as Claude Code does) so the secret never appears in the
    // process list, where other local users could read it. Throws before running `security`
    // when the login is too large to pass this way.
    await run('security', ['-i'], keychainWriteCommand(p, json));
    // Keep any file copy in step so a stale file login can't win.
    if (fs.existsSync(p.credentialsFile)) {
      await writeFileAtomic(p.credentialsFile, json, 0o600);
    }
    return;
  }
  await writeFileAtomic(p.credentialsFile, json, 0o600);
}

interface GlobalConfig {
  oauthAccount?: Record<string, unknown>;
  cachedUsageUtilization?: { fetchedAtMs?: number; accountUuid?: string; utilization?: unknown };
  [key: string]: unknown;
}

export async function readGlobalConfig(p: ClaudePaths): Promise<GlobalConfig | undefined> {
  try {
    return await readJson<GlobalConfig>(p.globalConfigFile);
  } catch {
    // Claude Code may be mid-write; the caller will try again on the next change.
    return undefined;
  }
}

/**
 * Point Claude Code's displayed account (`oauthAccount` in ~/.claude.json) at the new login.
 * Only that key is touched; the rest of the file is written back as it was read.
 */
export async function writeOAuthAccount(p: ClaudePaths, oauthAccount: Record<string, unknown>): Promise<void> {
  const raw = await fs.promises.readFile(p.globalConfigFile, 'utf8');
  const config = JSON.parse(raw) as GlobalConfig;
  config.oauthAccount = oauthAccount;
  await writeFileAtomic(p.globalConfigFile, JSON.stringify(config, null, 2));
}
