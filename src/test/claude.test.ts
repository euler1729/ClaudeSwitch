import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keychainWriteCommand, resolvePaths, run } from '../claude';

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
