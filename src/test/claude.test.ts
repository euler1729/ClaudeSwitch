import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { SECURITY_MAX_LINE, keychainWriteCommand, readCredentials, resolvePaths, run, writeCredentials } from '../claude';
import { CredentialsBlob } from '../types';

/** A login whose JSON is padded (like Claude Code's MCP tokens would) to `bytes` long. */
function loginOfSize(tag: string, bytes: number): CredentialsBlob {
  const blob: CredentialsBlob = {
    claudeAiOauth: { accessToken: `at-${tag}`, refreshToken: `rt-${tag}`, expiresAt: 1, scopes: ['user:inference'] },
    mcpOAuth: { pad: '' },
  };
  (blob.mcpOAuth as { pad: string }).pad = 'm'.repeat(bytes - JSON.stringify(blob).length);
  return blob;
}

test('secrets are passed to child processes on stdin, not as arguments', async () => {
  assert.equal(await run('cat', [], 'secret-token'), 'secret-token');
});

test('the Keychain write command carries the credentials hex-encoded', () => {
  const paths = { ...resolvePaths(''), keychainAccount: 'alice', keychainService: 'Claude Code-credentials' };
  const json = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-abc' } });
  const cmd = keychainWriteCommand(paths, json);
  assert.equal(
    cmd,
    `add-generic-password -U -a "alice" -s "Claude Code-credentials" -X "${Buffer.from(json).toString('hex')}"\n`,
  );
  assert.ok(!cmd.includes('sk-ant'), 'raw token never appears in the command');
});

test('a login too large for `security -i` is refused instead of being cut short', () => {
  const paths = { ...resolvePaths(''), keychainAccount: 'alice', keychainService: 'Claude Code-credentials' };
  const overhead = keychainWriteCommand(paths, '').length - 1;
  const largest = Math.floor((SECURITY_MAX_LINE - overhead) / 2);
  const fits = JSON.stringify(loginOfSize('a', largest));
  assert.equal(keychainWriteCommand(paths, fits).length - 1, overhead + 2 * largest);
  assert.ok(keychainWriteCommand(paths, fits).length - 1 <= SECURITY_MAX_LINE);
  assert.throws(() => keychainWriteCommand(paths, JSON.stringify(loginOfSize('a', largest + 1))), /too large.*not changed/);
});

test('macOS Keychain: logins round-trip up to the limit, and a larger one leaves the stored login intact', { skip: process.platform !== 'darwin' }, async () => {
  // A throwaway config dir gives a throwaway item ("Claude Code-credentials-<hash>").
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeswitch-kc-'));
  const paths = resolvePaths(tmp);
  assert.notEqual(paths.keychainService, 'Claude Code-credentials');
  const largest = Math.floor((SECURITY_MAX_LINE - (keychainWriteCommand(paths, '').length - 1)) / 2);
  try {
    const big = loginOfSize('big', largest);
    await writeCredentials(paths, big);
    assert.deepEqual(await readCredentials(paths), big, 'the largest allowed login is stored in full');

    const small = loginOfSize('small', 300);
    await writeCredentials(paths, small);
    await assert.rejects(writeCredentials(paths, loginOfSize('huge', largest + 1)), /too large/);
    assert.deepEqual(await readCredentials(paths), small, 'the stored login is unchanged');
    assert.equal(fs.existsSync(paths.credentialsFile), false, 'no plaintext file is created');
  } finally {
    spawnSync('security', ['delete-generic-password', '-a', paths.keychainAccount, '-s', paths.keychainService]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the Keychain account name is limited to safe characters', () => {
  const saved = process.env.USER;
  try {
    process.env.USER = 'bob" -s "evil';
    assert.equal(resolvePaths('').keychainAccount, 'claude-code-user');
    process.env.USER = 'bob.smith-2';
    assert.equal(resolvePaths('').keychainAccount, 'bob.smith-2');
  } finally {
    process.env.USER = saved;
  }
});
