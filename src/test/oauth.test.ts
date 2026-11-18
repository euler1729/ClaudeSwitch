import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import { createHash } from 'crypto';
import { CLIENT_ID } from '../api';
import { LoginSession, MANUAL_REDIRECT_URL, SCOPES, SUCCESS_URL, buildAuthorizeUrl, createPkce, credentialsFromLogin } from '../oauth';

function get(url: string): Promise<{ status?: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body }));
      })
      .on('error', reject);
  });
}

// Fake token + profile endpoints; records what was sent.
const sent: any[] = [];
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.endsWith('/v1/oauth/token')) {
    const body = JSON.parse(String(init?.body));
    sent.push(body);
    if (body.code === 'bad') {
      return new Response('{"error":"invalid_grant"}', { status: 400 });
    }
    return Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'user:inference user:profile' });
  }
  if (u.endsWith('/api/oauth/profile')) {
    return Response.json({
      account: { uuid: 'u1', email: 'me@example.com' },
      organization: { uuid: 'o1', organization_type: 'claude_pro', rate_limit_tier: 'default_claude_ai' },
    });
  }
  return new Response('', { status: 404 });
}) as typeof fetch;

test('PKCE challenge is the S256 hash of the verifier', () => {
  const p = createPkce();
  const expected = createHash('sha256').update(p.verifier).digest('base64url');
  assert.equal(p.challenge, expected);
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(createPkce().state, p.state);
});

test('authorize URL carries the Claude Code client, scopes and PKCE parameters', () => {
  const url = new URL(buildAuthorizeUrl({ challenge: 'ch', state: 'st', redirectUri: 'http://localhost:5555/callback' }));
  assert.equal(url.origin + url.pathname, 'https://claude.com/cai/oauth/authorize');
  const q = Object.fromEntries(url.searchParams);
  assert.deepEqual(q, {
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: 'http://localhost:5555/callback',
    scope: SCOPES.join(' '),
    code_challenge: 'ch',
    code_challenge_method: 'S256',
    state: 'st',
  });
});

test("authorize URL survives VS Code's openExternal (decode query, then encodeURI)", () => {
  const original = buildAuthorizeUrl({ challenge: 'a-b_c', state: 'x_y-z', redirectUri: 'http://localhost:5555/callback', loginHint: 'me@example.com' });
  const [base, query] = original.split('?');
  const reopened = new URL(`${base}?${encodeURI(decodeURIComponent(query))}`);
  assert.deepEqual(Object.fromEntries(reopened.searchParams), Object.fromEntries(new URL(original).searchParams));
});

test('login hint is skipped for addresses that would be mangled', () => {
  const withPlus = new URL(buildAuthorizeUrl({ challenge: 'c', state: 's', redirectUri: 'r', loginHint: 'me+work@example.com' }));
  assert.equal(withPlus.searchParams.get('login_hint'), null);
  const plain = new URL(buildAuthorizeUrl({ challenge: 'c', state: 's', redirectUri: 'r', loginHint: 'me@example.com' }));
  assert.equal(plain.searchParams.get('login_hint'), 'me@example.com');
});

test('callback listener: ignores stale links, accepts the right one, then redirects to the success page', async () => {
  const s = await LoginSession.start();
  try {
    const base = `http://127.0.0.1:${s.listenerPort}`;
    assert.equal((await get(`${base}/favicon.ico`)).status, 404);
    const stale = await get(`${base}/callback?code=x&state=wrong`);
    assert.equal(stale.status, 400);
    assert.match(stale.body, /out of date/);

    const browser = get(`${base}/callback?code=the-code&state=${s.pkce.state}`);
    assert.equal(await s.callback, 'the-code');
    const again = await get(`${base}/callback?code=the-code&state=${s.pkce.state}`);
    assert.match(again.body, /already finishing/);

    const result = await s.complete('the-code', 'callback');
    const landed = await browser;
    assert.equal(landed.status, 302);
    assert.equal(landed.location, SUCCESS_URL);
    assert.equal(sent.at(-1).redirect_uri, s.redirectUri);
    assert.equal(sent.at(-1).code_verifier, s.pkce.verifier);
    assert.equal(sent.at(-1).grant_type, 'authorization_code');
    assert.equal(result.profile.account.email, 'me@example.com');
  } finally {
    s.close();
  }
});

test('callback listener reports a denied sign-in', async () => {
  const s = await LoginSession.start();
  try {
    const page = await get(`http://127.0.0.1:${s.listenerPort}/callback?error=access_denied&state=${s.pkce.state}`);
    assert.match(page.body, /cancelled or failed/);
    await assert.rejects(s.callback, /access_denied/);
  } finally {
    s.close();
  }
});

test('pasted codes: "code#state" is checked and exchanged against the code page redirect', async () => {
  const s = await LoginSession.start();
  try {
    await assert.rejects(s.complete('abc#someone-elses-state', 'manual'), /different sign-in attempt/);
    await s.complete(`  abc#${s.pkce.state}  `, 'manual');
    assert.equal(sent.at(-1).code, 'abc');
    assert.equal(sent.at(-1).redirect_uri, MANUAL_REDIRECT_URL);
    await assert.rejects(s.complete('bad', 'manual'), /rejected/);
  } finally {
    s.close();
  }
});

test('closing a session stops the listener and cancels the wait', async () => {
  const s = await LoginSession.start();
  const port = s.listenerPort;
  s.close();
  await assert.rejects(s.callback, /cancelled/);
  await assert.rejects(get(`http://127.0.0.1:${port}/callback`));
});

test('credentials are stored the way Claude Code stores its own', () => {
  const now = 1_000_000;
  const blob = credentialsFromLogin(
    { access_token: 'at', refresh_token: 'rt', expires_in: 3600, refresh_token_expires_in: 7200, scope: 'user:inference user:profile' },
    { account: { uuid: 'u', email: 'e' }, organization: { uuid: 'o', organization_type: 'claude_team', rate_limit_tier: 'tier' } },
    now,
  );
  assert.deepEqual(blob, {
    claudeAiOauth: {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: now + 3_600_000,
      refreshTokenExpiresAt: now + 7_200_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'team',
      subscriptionTypeSource: 'profile',
      rateLimitTier: 'tier',
    },
    organizationUuid: 'o',
  });
});
