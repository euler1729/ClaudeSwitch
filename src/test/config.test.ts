import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import Module = require('module');

// Route `require('vscode')` to the stub, which returns each setting's built-in fallback.
const M = Module as any;
const originalResolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? require.resolve('./vscodeStub') : originalResolve.call(this, request, ...rest);
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readConfig } = require('../config') as typeof import('../config');

test('built-in fallbacks match the defaults declared in package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const declared = pkg.contributes.configuration.properties as Record<string, { default: unknown }>;
  const config = readConfig() as unknown as Record<string, unknown>;
  for (const [key, spec] of Object.entries(declared)) {
    const name = key.replace(/^claudeswitch\./, '');
    assert.deepEqual(config[name], spec.default, name);
  }
});

test('accounts switch at 90% by default', () => {
  assert.equal(readConfig().switchThreshold, 90);
});
