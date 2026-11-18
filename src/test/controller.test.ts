import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import Module = require('module');
import * as stub from './vscodeStub';

/*
 * End-to-end run of the Controller against a throwaway Claude config directory and a fake
 * Anthropic API. Never touches the real ~/.claude.
 */

// Route `require('vscode')` to the stub.
const M = Module as any;
const originalResolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? require.resolve('./vscodeStub') : originalResolve.call(this, request, ...rest);
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Controller, UnmanagedLoginError } = require('../controller') as typeof import('../controller');
const { LoginSession, SUCCESS_URL } = require('../oauth') as typeof import('../oauth');

// ── fake server ──
interface FakeAccount {
  uuid: string;
  org: string;
  email: string;
  session: number;
  weekly: number;
}
const accounts: Record<string, FakeAccount> = {
  a: { uuid: 'ua', org: 'oa', email: 'a@example.com', session: 5, weekly: 20 },
  b: { uuid: 'ub', org: 'ob', email: 'b@example.com', session: 5, weekly: 20 },
  c: { uuid: 'uc', org: 'oc', email: 'c@example.com', session: 5, weekly: 20 },
};
const accessTokens = new Map<string, string>(); // token -> account key
const refreshTokens = new Map<string, string>();
let counter = 0;
let refreshCalls = 0;

function issue(key: string, expiresInMs = 8 * 3600_000) {
  counter++;
  const access = `at-${key}-${counter}`;
  const refresh = `rt-${key}-${counter}`;
  accessTokens.set(access, key);
  refreshTokens.set(refresh, key);
  return {
    claudeAiOauth: {
      accessToken: access,
      refreshToken: refresh,
      expiresAt: Date.now() + expiresInMs,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    },
    organizationUuid: accounts[key].org,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const resetsIn = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
// Fixed window ends, like the real API (a window's end doesn't move between polls).
const SESSION_RESET = resetsIn(3);
const WEEKLY_RESET = resetsIn(100);

globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.endsWith('/v1/oauth/token')) {
    refreshCalls++;
    const body = JSON.parse(String(init?.body));
    if (body.grant_type === 'authorization_code') {
      // Browser sign-in: codes look like "code-<account>".
      const key = /^code-(\w)$/.exec(body.code)?.[1];
      if (!key || !body.code_verifier || !body.redirect_uri || !body.state) {
        return json(400, { error: 'invalid_grant' });
      }
      const t = issue(key).claudeAiOauth;
      return json(200, { access_token: t.accessToken, refresh_token: t.refreshToken, expires_in: 28800, scope: 'user:inference user:profile' });
    }
    const key = refreshTokens.get(body.refresh_token);
    if (!key) {
      return json(400, { error: 'invalid_grant' });
    }
    refreshTokens.delete(body.refresh_token); // rotation: old refresh token is now dead
    const next = issue(key).claudeAiOauth;
    return json(200, { access_token: next.accessToken, refresh_token: next.refreshToken, expires_in: 28800 });
  }
  const token = String((init?.headers as Record<string, string>)?.Authorization ?? '').replace('Bearer ', '');
  const key = accessTokens.get(token);
  if (!key) {
    return json(401, { error: 'unauthorized' });
  }
  const acct = accounts[key];
  if (u.endsWith('/api/oauth/profile')) {
    return json(200, {
      account: { uuid: acct.uuid, email: acct.email },
      organization: { uuid: acct.org, name: `Org ${key}`, organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' },
    });
  }
  if (u.endsWith('/api/oauth/usage')) {
    return json(200, {
      limits: [
        { kind: 'session', group: 'session', percent: acct.session, resets_at: SESSION_RESET },
        { kind: 'weekly_all', group: 'weekly', percent: acct.weekly, resets_at: WEEKLY_RESET },
      ],
    });
  }
  return json(404, {});
}) as typeof fetch;

// ── helpers ──
/** Plays the browser being sent back to the local listener. */
function browserVisit(url: string): Promise<{ status?: number; location?: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location });
    }).on('error', reject);
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error('timed out waiting for condition');
    }
    await sleep(25);
  }
}

test('add, rotate, switch, auto-switch and protect unmanaged logins', { skip: process.platform === 'darwin' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeswitch-test-'));
  const configDir = path.join(tmp, 'claude');
  fs.mkdirSync(configDir);
  const credFile = path.join(configDir, '.credentials.json');
  const globalFile = path.join(configDir, '.claude.json');
  const readCreds = () => JSON.parse(fs.readFileSync(credFile, 'utf8'));
  const readGlobal = () => JSON.parse(fs.readFileSync(globalFile, 'utf8'));
  const login = (key: string, expiresInMs?: number) => {
    const blob = issue(key, expiresInMs);
    fs.writeFileSync(credFile, JSON.stringify(blob));
    const g = fs.existsSync(globalFile) ? readGlobal() : { numStartups: 7 };
    g.oauthAccount = { accountUuid: accounts[key].uuid, emailAddress: accounts[key].email, organizationUuid: accounts[key].org };
    fs.writeFileSync(globalFile, JSON.stringify(g, null, 2));
    return blob;
  };

  Object.assign(stub.settings, { claudeConfigDir: configDir, autoAddNewLogins: false, notifyOnSwitch: true });
  const secrets = new stub.MemorySecrets();
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(`WARN ${m}`), error: (m: string) => logs.push(`ERR ${m}`) };
  const ctx = { globalStorageUri: { fsPath: path.join(tmp, 'storage') }, secrets, subscriptions: [] as unknown[] };
  const vaultGet = (id: string) => JSON.parse(secrets.data.get(`claudeswitch.credentials.${id}`)!);

  login('a');
  const c = new Controller(ctx as any, log as any);
  try {
    await c.start();
    assert.equal(c.unmanagedLogin?.email, 'a@example.com', 'current login is detected but not auto-added');
    assert.equal(c.state.accounts().length, 0);

    // 1. Add the current login.
    const a = await c.addCurrentAccount();
    assert.equal(a?.id, 'ua:oa');
    assert.equal(c.state.current.activeId, 'ua:oa');

    // 2. "Add Claude Account": browser sign-in adds B without touching Claude Code's login.
    const session = await LoginSession.start();
    const browser = browserVisit(`http://127.0.0.1:${session.listenerPort}/callback?code=code-b&state=${session.pkce.state}`);
    const signedIn = await session.complete(await session.callback, 'callback');
    session.close();
    assert.deepEqual(await browser, { status: 302, location: SUCCESS_URL }, 'browser lands on the success page');
    assert.equal(signedIn.creds.claudeAiOauth.subscriptionType, 'max');
    assert.equal(signedIn.creds.claudeAiOauth.rateLimitTier, 'default_claude_max_20x');
    const added = await c.addSignedInAccount(signedIn.creds, signedIn.profile);
    assert.equal(added.isNew, true);
    assert.deepEqual(c.state.accounts().map((x) => x.id), ['ua:oa', 'ub:ob']);
    assert.equal(c.state.current.activeId, 'ua:oa', 'still on A');
    assert.equal(accessTokens.get(readCreds().claudeAiOauth.accessToken), 'a', "Claude Code's login untouched");

    // Use B (its fresh token is written as-is, no refresh needed).
    const refreshesBefore = refreshCalls;
    assert.equal(await c.switchTo('ub:ob', 'test', { automatic: false }), true);
    assert.equal(refreshCalls, refreshesBefore, 'a fresh token is used as-is');
    assert.equal(accessTokens.get(readCreds().claudeAiOauth.accessToken), 'b');
    assert.equal(readGlobal().oauthAccount.emailAddress, 'b@example.com');

    // 3. Claude Code rotates B's tokens; ClaudeSwitch keeps its copy current.
    const rotated = issue('b');
    fs.writeFileSync(credFile, JSON.stringify(rotated));
    await c.syncActive();
    assert.equal(vaultGet('ub:ob').claudeAiOauth.refreshToken, rotated.claudeAiOauth.refreshToken);

    // 4. Manual switch back to A, whose stored access token has expired: it is refreshed first.
    const storedA = vaultGet('ua:oa');
    storedA.claudeAiOauth.expiresAt = Date.now() - 1000;
    await secrets.store('claudeswitch.credentials.ua:oa', JSON.stringify(storedA));
    const before = refreshCalls;
    assert.equal(await c.switchTo('ua:oa', 'test', { automatic: false }), true);
    assert.equal(refreshCalls, before + 1);
    const live = readCreds();
    assert.equal(live.claudeAiOauth.refreshToken, vaultGet('ua:oa').claudeAiOauth.refreshToken);
    assert.notEqual(live.claudeAiOauth.refreshToken, storedA.claudeAiOauth.refreshToken, 'refreshed token was written');
    assert.ok(live.claudeAiOauth.expiresAt > Date.now());
    assert.equal(readGlobal().oauthAccount.emailAddress, 'a@example.com');
    assert.equal(readGlobal().numStartups, 7, 'other keys in .claude.json are preserved');
    assert.equal((fs.statSync(credFile).mode & 0o777).toString(8), '600');
    assert.equal(c.state.current.lastSwitch?.to, 'ua:oa');

    // 5. A hits its session limit -> the leader switches to B on its own.
    await until(() => c.isLeader);
    accounts.a.session = 97;
    await c.pollActive(true);
    await until(() => c.state.current.activeId === 'ub:ob');
    assert.equal(readCreds().claudeAiOauth.refreshToken, vaultGet('ub:ob').claudeAiOauth.refreshToken);
    assert.equal(readGlobal().oauthAccount.emailAddress, 'b@example.com');
    assert.ok(stub.messages.some(([, m]) => /switched to b@example\.com — a@example\.com reached its Session \(5h\) limit/.test(m)));

    // 6. Both exhausted -> one warning with the recovery time, no switching back and forth.
    accounts.b.weekly = 100;
    await c.pollActive(true);
    assert.equal(c.lastDecision?.kind, 'exhausted');
    assert.equal(c.state.current.activeId, 'ub:ob');
    assert.equal(stub.messages.filter(([, m]) => /every Claude account is at its limit/.test(m)).length, 1);

    // 7. An unmanaged login is never overwritten by an automatic switch.
    accounts.b.weekly = 20;
    login('c');
    await c.syncActive();
    assert.equal(c.unmanagedLogin?.email, 'c@example.com');
    assert.equal(c.state.current.activeId, undefined);
    await assert.rejects(c.switchTo('ub:ob', 'auto', { automatic: true }), UnmanagedLoginError);
    assert.equal(accessTokens.get(readCreds().claudeAiOauth.accessToken), 'c', 'login C left untouched');

    // 8. A dead refresh token marks the account as needing a new login instead of failing silently.
    const storedB = vaultGet('ub:ob');
    storedB.claudeAiOauth.expiresAt = Date.now() - 1000;
    storedB.claudeAiOauth.refreshToken = 'rt-revoked';
    await secrets.store('claudeswitch.credentials.ub:ob', JSON.stringify(storedB));
    await assert.rejects(c.switchTo('ub:ob', 'manual', { automatic: false, overwriteUnmanaged: true }), /sign in to it again/i);
    assert.equal(c.state.account('ub:ob')?.needsReauth, true);
    assert.equal(accessTokens.get(readCreds().claudeAiOauth.accessToken), 'c', 'a failed switch leaves the login alone');

    // 9. "Sign In Again" through the browser repairs it, still without touching the live login.
    const again = await LoginSession.start({ loginHint: 'b@example.com' });
    assert.equal(new URL(again.automaticUrl).searchParams.get('login_hint'), 'b@example.com');
    const visit = browserVisit(`http://127.0.0.1:${again.listenerPort}/callback?code=code-b&state=${again.pkce.state}`);
    const renewed = await again.complete(await again.callback, 'callback');
    again.close();
    await visit;
    const result = await c.addSignedInAccount(renewed.creds, renewed.profile);
    assert.equal(result.isNew, false);
    assert.equal(c.state.account('ub:ob')?.needsReauth, false);
    assert.equal(accessTokens.get(readCreds().claudeAiOauth.accessToken), 'c');
    assert.equal(await c.switchTo('ub:ob', 'manual', { automatic: false, overwriteUnmanaged: true }), true);
    assert.equal(accessTokens.get(readCreds().claudeAiOauth.accessToken), 'b');
  } catch (err) {
    console.error(logs.join('\n'));
    throw err;
  } finally {
    c.dispose();
    await sleep(50);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
