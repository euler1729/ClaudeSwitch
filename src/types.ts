/** The `claudeAiOauth` object Claude Code keeps in its credential store. */
export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
  [key: string]: unknown;
}

/** The whole credential blob (`~/.claude/.credentials.json` or the macOS keychain item). */
export interface CredentialsBlob {
  claudeAiOauth: OAuthCredentials;
  organizationUuid?: string;
  [key: string]: unknown;
}

/** Non-secret information about a managed account. Tokens live in VS Code SecretStorage. */
export interface AccountMeta {
  /** `<accountUuid>:<organizationUuid>` — one login per account/organization pair. */
  id: string;
  accountUuid: string;
  organizationUuid?: string;
  email: string;
  label: string;
  organizationName?: string;
  subscriptionType?: string;
  /** Whether automatic switching may pick this account. */
  enabled: boolean;
  /** Lower number = higher priority (used by the sequential strategy and as a tie-breaker). */
  priority: number;
  addedAt: number;
  /** Snapshot of the `oauthAccount` entry in Claude Code's global config, restored on switch. */
  oauthAccount?: Record<string, unknown>;
  /** Set when the stored refresh token was rejected; the user must log in to this account again. */
  needsReauth?: boolean;
  lastError?: string;
}

export type WindowGroup = 'session' | 'weekly' | 'other';

export interface UsageWindow {
  key: string;
  group: WindowGroup;
  label: string;
  /** 0–100 */
  percent: number;
  /** Epoch ms; undefined when the window hasn't started. */
  resetsAt?: number;
}

export interface UsageSnapshot {
  fetchedAt: number;
  source: 'api' | 'claude-cache';
  windows: UsageWindow[];
}

export interface SwitchRecord {
  from?: string;
  to: string;
  reason: string;
  at: number;
  automatic: boolean;
}
