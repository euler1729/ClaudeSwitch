import { OAuthCredentials } from './types';

/* Calls to Claude's OAuth endpoints — the same ones Claude Code uses for `/usage` and token refresh. */

const API_BASE = 'https://api.anthropic.com';
export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
/** Claude Code's public OAuth client id; tokens are bound to it, so Claude Code can use what we obtain. */
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const USER_AGENT = 'claudeswitch-vscode/0.2.0';

export class ApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
  }

  /** The refresh token is no longer valid; only a fresh login fixes this. */
  get isAuthDead(): boolean {
    return this.code === 'invalid_grant' || this.status === 400 || this.status === 401;
  }
}

async function getJson(pathname: string, accessToken: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(API_BASE + pathname, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err: any) {
    throw new ApiError(`${pathname}: ${err?.message ?? err}`);
  }
  if (!res.ok) {
    throw new ApiError(`${pathname}: HTTP ${res.status}`, res.status);
  }
  return res.json();
}

export function fetchUsage(accessToken: string): Promise<unknown> {
  return getJson('/api/oauth/usage', accessToken);
}

export interface Profile {
  account: { uuid: string; email: string; display_name?: string; full_name?: string; created_at?: string };
  organization?: {
    uuid: string;
    name?: string;
    organization_type?: string;
    billing_type?: string;
    rate_limit_tier?: string;
    seat_tier?: string;
    has_extra_usage_enabled?: boolean;
    subscription_created_at?: string;
    cc_onboarding_flags?: Record<string, unknown>;
  };
}

/** Same mapping Claude Code uses to derive the plan from the organization type. */
export function subscriptionTypeFor(organizationType: string | undefined): string | undefined {
  const map: Record<string, string> = {
    claude_max: 'max',
    claude_pro: 'pro',
    claude_enterprise: 'enterprise',
    claude_team: 'team',
  };
  return organizationType ? map[organizationType] : undefined;
}

export async function fetchProfile(accessToken: string): Promise<Profile> {
  const p = (await getJson('/api/oauth/profile', accessToken)) as Profile;
  if (!p?.account?.uuid) {
    throw new ApiError('/api/oauth/profile: unexpected response');
  }
  return p;
}

/** Same shape Claude Code writes into `oauthAccount` after login, built from the profile endpoint. */
export function oauthAccountFromProfile(p: Profile): Record<string, unknown> {
  const o = p.organization;
  const entry: Record<string, unknown> = {
    accountUuid: p.account.uuid,
    emailAddress: p.account.email,
    organizationUuid: o?.uuid,
    displayName: p.account.display_name,
    fullName: p.account.full_name,
    accountCreatedAt: p.account.created_at,
    organizationName: o?.name,
    organizationType: o?.organization_type,
    billingType: o?.billing_type,
    organizationRateLimitTier: o?.rate_limit_tier,
    seatTier: o?.seat_tier,
    hasExtraUsageEnabled: o?.has_extra_usage_enabled,
    subscriptionCreatedAt: o?.subscription_created_at,
    ccOnboardingFlags: o ? (o.cc_onboarding_flags ?? {}) : undefined,
    profileFetchedAt: Date.now(),
  };
  for (const k of Object.keys(entry)) {
    if (entry[k] === undefined) {
      delete entry[k];
    }
  }
  return entry;
}

/**
 * Exchange a refresh token for a new access token. The response may rotate the refresh token,
 * so the caller must persist the result before anything else uses the old one.
 * Never call this for the account Claude Code is currently using — Claude Code owns that token.
 */
export async function refreshCredentials(creds: OAuthCredentials): Promise<OAuthCredentials> {
  const body: Record<string, unknown> = {
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    client_id: CLIENT_ID,
  };
  if (creds.scopes?.length) {
    body.scope = creds.scopes.join(' ');
  }
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: any) {
    throw new ApiError(`token refresh: ${err?.message ?? err}`);
  }
  if (!res.ok) {
    let code: string | undefined;
    try {
      code = ((await res.json()) as any)?.error;
    } catch {
      // ignore
    }
    throw new ApiError(`token refresh: HTTP ${res.status}${code ? ` (${code})` : ''}`, res.status, code);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    refresh_token_expires_in?: number;
    scope?: string;
  };
  if (!data?.access_token || typeof data.expires_in !== 'number') {
    throw new ApiError('token refresh: unexpected response');
  }
  const now = Date.now();
  const next: OAuthCredentials = {
    ...creds,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? creds.refreshToken,
    expiresAt: now + data.expires_in * 1000,
  };
  if (typeof data.refresh_token_expires_in === 'number') {
    next.refreshTokenExpiresAt = now + data.refresh_token_expires_in * 1000;
  }
  if (data.scope) {
    next.scopes = data.scope.split(' ').filter(Boolean);
  }
  return next;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in?: number;
  scope?: string;
}

/** Second half of the browser sign-in: trade the authorization code for tokens (PKCE). */
export async function exchangeAuthorizationCode(p: {
  code: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: p.code,
        redirect_uri: p.redirectUri,
        client_id: CLIENT_ID,
        code_verifier: p.codeVerifier,
        state: p.state,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: any) {
    throw new ApiError(`sign-in: ${err?.message ?? err}`);
  }
  if (!res.ok) {
    throw new ApiError(
      res.status === 400 || res.status === 401
        ? 'sign-in: the authorization code was rejected (it may have expired or already been used)'
        : `sign-in: HTTP ${res.status}`,
      res.status,
    );
  }
  const data = (await res.json()) as TokenResponse;
  if (!data?.access_token || !data.refresh_token || typeof data.expires_in !== 'number') {
    throw new ApiError('sign-in: unexpected token response');
  }
  return data;
}
