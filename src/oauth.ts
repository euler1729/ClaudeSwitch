import * as http from 'http';
import { createHash, randomBytes } from 'crypto';
import { CLIENT_ID, Profile, TokenResponse, exchangeAuthorizationCode, fetchProfile, subscriptionTypeFor } from './api';
import { CredentialsBlob, OAuthCredentials } from './types';

/*
 * Browser sign-in for adding accounts — the same OAuth 2.0 + PKCE flow `claude auth login` runs,
 * but performed by ClaudeSwitch so no terminal is needed and the current Claude Code login is left
 * alone. The browser is sent back to a one-shot listener on 127.0.0.1; if that can't be reached
 * (remote/web VS Code), the sign-in page can instead show a code to paste.
 * No VS Code imports, so this is unit-testable.
 */

export const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
export const MANUAL_REDIRECT_URL = 'https://platform.claude.com/oauth/code/callback';
export const SUCCESS_URL = 'https://platform.claude.com/oauth/code/success?app=claude-code';
export const SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
  'user:plugins',
];

const base64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
}

export function createPkce(): Pkce {
  const verifier = base64url(randomBytes(32));
  return {
    verifier,
    challenge: base64url(createHash('sha256').update(verifier).digest()),
    state: base64url(randomBytes(32)),
  };
}

/**
 * Values are percent-encoded with %20 for spaces (never "+"), so the URL survives VS Code's
 * openExternal, which decodes the query and re-encodes it with encodeURI.
 */
export function buildAuthorizeUrl(p: { challenge: string; state: string; redirectUri: string; loginHint?: string }): string {
  const params: Array<[string, string]> = [
    ['code', 'true'],
    ['client_id', CLIENT_ID],
    ['response_type', 'code'],
    ['redirect_uri', p.redirectUri],
    ['scope', SCOPES.join(' ')],
    ['code_challenge', p.challenge],
    ['code_challenge_method', 'S256'],
    ['state', p.state],
  ];
  // "+" can't survive the decode/re-encode round trip, so skip the hint for such addresses.
  if (p.loginHint && !/[+&#%=]/.test(p.loginHint)) {
    params.push(['login_hint', p.loginHint]);
  }
  return `${AUTHORIZE_URL}?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

export function credentialsFromLogin(tokens: TokenResponse, profile: Profile, now = Date.now()): CredentialsBlob {
  const oauth: OAuthCredentials = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: now + tokens.expires_in * 1000,
    scopes: tokens.scope ? tokens.scope.split(' ').filter(Boolean) : [...SCOPES],
  };
  if (typeof tokens.refresh_token_expires_in === 'number') {
    oauth.refreshTokenExpiresAt = now + tokens.refresh_token_expires_in * 1000;
  }
  const plan = subscriptionTypeFor(profile.organization?.organization_type);
  if (plan) {
    oauth.subscriptionType = plan;
    oauth.subscriptionTypeSource = 'profile';
  }
  if (profile.organization?.rate_limit_tier) {
    oauth.rateLimitTier = profile.organization.rate_limit_tier;
  }
  const blob: CredentialsBlob = { claudeAiOauth: oauth };
  if (profile.organization?.uuid) {
    blob.organizationUuid = profile.organization.uuid;
  }
  return blob;
}

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  '<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}' +
  '@media(prefers-color-scheme:dark){body{background:#1e1e1e;color:#ddd}}</style></head>' +
  `<body><h1 style="font-size:1.3rem">${title}</h1><p>${body}</p></body></html>`;

export interface LoginResult {
  creds: CredentialsBlob;
  profile: Profile;
}

/** One sign-in attempt: a PKCE pair, a callback listener and the two sign-in URLs. */
export class LoginSession {
  readonly pkce = createPkce();
  private readonly server: http.Server;
  private port = 0;
  private pendingResponse?: http.ServerResponse;
  private settled = false;
  private resolveCode!: (code: string) => void;
  private rejectCode!: (err: Error) => void;
  /** Resolves with the authorization code when the browser comes back to the listener. */
  readonly callback: Promise<string>;

  private constructor(private readonly loginHint?: string) {
    this.callback = new Promise<string>((resolve, reject) => {
      this.resolveCode = resolve;
      this.rejectCode = reject;
    });
    this.callback.catch(() => undefined); // the caller may never await it (e.g. when a code is pasted)
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  static async start(opts: { loginHint?: string } = {}): Promise<LoginSession> {
    const session = new LoginSession(opts.loginHint);
    await new Promise<void>((resolve, reject) => {
      session.server.once('error', reject);
      session.server.listen(0, '127.0.0.1', () => {
        session.port = (session.server.address() as { port: number }).port;
        resolve();
      });
    });
    return session;
  }

  get listenerPort(): number {
    return this.port;
  }

  get redirectUri(): string {
    return `http://localhost:${this.port}/callback`;
  }

  /** Sign-in page that returns to the local listener (no copy-paste). */
  get automaticUrl(): string {
    return buildAuthorizeUrl({ ...this.pkce, redirectUri: this.redirectUri, loginHint: this.loginHint });
  }

  /** Sign-in page that ends by showing a code to paste back. */
  get manualUrl(): string {
    return buildAuthorizeUrl({ ...this.pkce, redirectUri: MANUAL_REDIRECT_URL, loginHint: this.loginHint });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const state = url.searchParams.get('state');
    if (state !== this.pkce.state) {
      res
        .writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(page('This sign-in link is out of date', 'Start again from ClaudeSwitch in VS Code.'));
      return;
    }
    if (this.settled) {
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(page('Sign-in is already finishing', 'You can close this tab.'));
      return;
    }
    this.settled = true;
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (error || !code) {
      const detail = url.searchParams.get('error_description') ?? error ?? 'no authorization code';
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(page('Sign-in was cancelled or failed', 'You can close this tab and try again from VS Code.'));
      this.rejectCode(new Error(`Sign-in failed: ${detail}`));
      return;
    }
    this.pendingResponse = res; // answered after the token exchange
    this.resolveCode(code);
  }

  /**
   * Exchange a code for tokens and look up the account. `input` is either the code from the
   * listener or what the user pasted from the code page ("code#state").
   */
  async complete(input: string, source: 'callback' | 'manual'): Promise<LoginResult> {
    let code = input.trim();
    if (source === 'manual') {
      const [c, s] = code.split('#');
      if (s && s !== this.pkce.state) {
        throw new Error('That code is from a different sign-in attempt. Use the code from the page ClaudeSwitch just opened.');
      }
      code = c.trim();
      if (!code) {
        throw new Error('Paste the code shown on the sign-in page.');
      }
    }
    try {
      const tokens = await exchangeAuthorizationCode({
        code,
        state: this.pkce.state,
        codeVerifier: this.pkce.verifier,
        redirectUri: source === 'callback' ? this.redirectUri : MANUAL_REDIRECT_URL,
      });
      const profile = await fetchProfile(tokens.access_token);
      this.answerBrowser(true);
      return { creds: credentialsFromLogin(tokens, profile), profile };
    } catch (err) {
      this.answerBrowser(false);
      throw err;
    }
  }

  private answerBrowser(ok: boolean): void {
    const res = this.pendingResponse;
    this.pendingResponse = undefined;
    if (!res) {
      return;
    }
    if (ok) {
      res.writeHead(302, { Location: SUCCESS_URL }).end();
    } else {
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(page('Sign-in failed', 'Return to VS Code for details.'));
    }
  }

  close(): void {
    this.answerBrowser(false);
    this.rejectCode(new Error('Sign-in cancelled.'));
    this.server.close();
    this.server.closeAllConnections?.();
  }
}
