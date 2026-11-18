import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { ApiError, Profile, fetchProfile, fetchUsage, oauthAccountFromProfile, refreshCredentials } from './api';
import { ClaudePaths, readCredentials, readGlobalConfig, resolvePaths, writeCredentials, writeOAuthAccount } from './claude';
import { Config, readConfig } from './config';
import { formatClock } from './format';
import { Mutex } from './fsutil';
import { LeaderLease } from './leader';
import { CredentialVault, SharedState } from './state';
import { AccountState, Decision, decide, evaluateAccount } from './strategy';
import { LimitEvent, TranscriptWatcher } from './transcripts';
import { AccountMeta, CredentialsBlob } from './types';
import { normalizeUsage } from './usage';

const MIN_GAP_BETWEEN_AUTO_SWITCHES_MS = 20_000;
const FALLBACK_LIMIT_MS = 15 * 60_000;
const REFRESH_TOKEN_RENEW_MS = 3 * 24 * 3600_000;

export class UnmanagedLoginError extends Error {}

export interface UnmanagedLogin {
  id?: string;
  email?: string;
}

function accountId(accountUuid: string, organizationUuid?: string): string {
  return `${accountUuid}:${organizationUuid ?? 'none'}`;
}

function fingerprint(blob: CredentialsBlob | undefined): string {
  return blob ? createHash('sha256').update(blob.claudeAiOauth.refreshToken).digest('hex').slice(0, 16) : '';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Owns the account list, keeps usage fresh and performs switches. In each VS Code window there is
 * one Controller; only the elected leader polls and switches automatically.
 */
export class Controller implements vscode.Disposable {
  readonly state: SharedState;
  readonly vault: CredentialVault;
  private paths: ClaudePaths;
  private config: Config = readConfig();
  private readonly lease: LeaderLease;
  private transcripts?: TranscriptWatcher;
  private readonly mutex = new Mutex();
  private readonly timers: NodeJS.Timeout[] = [];
  private resetTimer?: NodeJS.Timeout;
  private keychainTimer?: NodeJS.Timeout;
  private credDebounce?: NodeJS.Timeout;
  private lastFingerprint = '';
  private activeSince = Date.now();
  private readonly backoffUntil = new Map<string, number>();
  private lastAutoSwitchAt = 0;
  private lastLimitEventAt = 0;
  private lastExhaustedNotice?: number;
  private disposed = false;

  unmanagedLogin?: UnmanagedLogin;
  lastDecision?: Decision;

  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly ctx: vscode.ExtensionContext, readonly log: vscode.LogOutputChannel) {
    const storage = ctx.globalStorageUri.fsPath;
    fs.mkdirSync(storage, { recursive: true });
    this.state = new SharedState(path.join(storage, 'state.json'));
    this.vault = new CredentialVault(ctx.secrets);
    this.paths = resolvePaths(this.config.claudeConfigDir);
    this.lease = new LeaderLease(path.join(storage, 'leader.json'), (isLeader) => this.onLeadershipChange(isLeader));
    this.state.onDidChange(() => this.emitter.fire());
  }

  get settings(): Config {
    return this.config;
  }

  get isLeader(): boolean {
    return this.lease.isLeader;
  }

  get claudePaths(): ClaudePaths {
    return this.paths;
  }

  async start(): Promise<void> {
    await this.state.load();
    await this.syncActive();
    this.watchCredentialStore();
    this.lease.start();
    this.ctx.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeswitch')) {
          this.onConfigChanged();
        }
      }),
    );
  }

  /** When the current account became active — whether this window or another one switched. */
  private activeSinceAny(): number {
    return Math.max(this.activeSince, this.state.current.lastSwitch?.at ?? 0);
  }

  // ───────────────────────────── views for the UI ─────────────────────────────

  accountStates(now = Date.now()): AccountState[] {
    const s = this.state.current;
    return this.state.accounts().map((a) =>
      evaluateAccount(
        {
          id: a.id,
          label: a.label,
          enabled: a.enabled,
          usable: !a.needsReauth,
          priority: a.priority,
          usage: s.usage[a.id],
          limitedUntil: s.limitedUntil[a.id],
        },
        this.config.switchThreshold,
        now,
      ),
    );
  }

  // ───────────────────────────── detecting the active login ─────────────────────────────

  private credListener = () => {
    clearTimeout(this.credDebounce);
    this.credDebounce = setTimeout(() => void this.onCredentialStoreChanged(), 500);
  };
  private globalConfigListener = () => void this.ingestClaudeCache();

  private watchCredentialStore(): void {
    fs.watchFile(this.paths.credentialsFile, { interval: 2000 }, this.credListener);
    fs.watchFile(this.paths.globalConfigFile, { interval: 5000 }, this.globalConfigListener);
    if (this.paths.useKeychain) {
      this.keychainTimer = setInterval(this.credListener, 15_000);
    }
  }

  private unwatchCredentialStore(): void {
    // Pass the listener: other extensions in this host may watch the same files.
    fs.unwatchFile(this.paths.credentialsFile, this.credListener);
    fs.unwatchFile(this.paths.globalConfigFile, this.globalConfigListener);
    if (this.keychainTimer) {
      clearInterval(this.keychainTimer);
      this.keychainTimer = undefined;
    }
  }

  private async onCredentialStoreChanged(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const creds = await readCredentials(this.paths);
    if (fingerprint(creds) === this.lastFingerprint) {
      return;
    }
    await this.syncActive();
    if (this.isLeader) {
      void this.pollActive();
    }
  }

  /**
   * Work out which managed account the current Claude Code login belongs to, and save its latest
   * tokens (Claude Code rotates them on refresh; the stored copy must keep up).
   */
  syncActive(): Promise<void> {
    return this.mutex.run(async () => {
      const creds = await readCredentials(this.paths);
      this.lastFingerprint = fingerprint(creds);
      if (!creds) {
        this.unmanagedLogin = undefined;
        if (this.state.current.activeId) {
          await this.state.update((d) => {
            d.activeId = undefined;
          });
        }
        this.emitter.fire();
        return;
      }

      const who = await this.identify(creds);
      const known = this.state.account(who?.id);
      if (known) {
        this.unmanagedLogin = undefined;
        const stored = await this.vault.get(known.id);
        if (
          !stored ||
          stored.claudeAiOauth.refreshToken !== creds.claudeAiOauth.refreshToken ||
          stored.claudeAiOauth.accessToken !== creds.claudeAiOauth.accessToken
        ) {
          await this.vault.set(known.id, creds);
        }
        if (this.state.current.activeId !== known.id || known.needsReauth) {
          if (this.state.current.activeId !== known.id) {
            this.activeSince = Date.now();
            this.log.info(`Active Claude login is now ${known.label}.`);
          }
          await this.state.update((d) => {
            d.activeId = known.id;
            const a = d.accounts.find((x) => x.id === known.id);
            if (a) {
              a.needsReauth = false;
              a.lastError = undefined;
            }
          });
        }
        this.emitter.fire();
        return;
      }

      // A login ClaudeSwitch doesn't manage yet.
      this.unmanagedLogin = { id: who?.id, email: who?.email };
      if (this.state.current.activeId) {
        await this.state.update((d) => {
          d.activeId = undefined;
        });
      }
      // Someone logged in through Claude Code itself (`/login`): add it if the setting allows.
      if (who?.profile && this.config.autoAddNewLogins && this.isLeader) {
        const meta = await this.saveAccount(creds, who.profile, true);
        this.unmanagedLogin = undefined;
        this.activeSince = Date.now();
        void vscode.window.showInformationMessage(`ClaudeSwitch: added ${meta.label}. It will be included in automatic switching.`);
      }
      this.emitter.fire();
    });
  }

  private async identify(creds: CredentialsBlob): Promise<{ id: string; email?: string; profile?: Profile } | undefined> {
    for (const a of this.state.accounts()) {
      const stored = await this.vault.get(a.id);
      if (
        stored &&
        (stored.claudeAiOauth.refreshToken === creds.claudeAiOauth.refreshToken ||
          stored.claudeAiOauth.accessToken === creds.claudeAiOauth.accessToken)
      ) {
        return { id: a.id, email: a.email };
      }
    }
    if (creds.claudeAiOauth.expiresAt > Date.now() + 30_000) {
      try {
        const profile = await fetchProfile(creds.claudeAiOauth.accessToken);
        return { id: accountId(profile.account.uuid, profile.organization?.uuid), email: profile.account.email, profile };
      } catch (err) {
        this.log.warn(`Could not look up the current login's profile: ${errorText(err)}`);
      }
    }
    // Offline or expired token: fall back to what Claude Code recorded for this login.
    const oa = (await readGlobalConfig(this.paths))?.oauthAccount;
    if (oa && typeof oa.accountUuid === 'string') {
      const org = (oa.organizationUuid as string | undefined) ?? creds.organizationUuid;
      return { id: accountId(oa.accountUuid, org), email: oa.emailAddress as string | undefined };
    }
    return undefined;
  }

  private async saveAccount(creds: CredentialsBlob, profile: Profile, makeActive: boolean): Promise<AccountMeta> {
    const id = accountId(profile.account.uuid, profile.organization?.uuid);
    const globalOa = (await readGlobalConfig(this.paths))?.oauthAccount;
    const oauthAccount =
      globalOa?.accountUuid === profile.account.uuid && globalOa?.organizationUuid === profile.organization?.uuid
        ? globalOa
        : oauthAccountFromProfile(profile);
    await this.vault.set(id, creds);
    let saved!: AccountMeta;
    await this.state.update((d) => {
      const existing = d.accounts.find((a) => a.id === id);
      const sameEmail = d.accounts.some((a) => a.id !== id && a.email === profile.account.email);
      const orgName = profile.organization?.name;
      saved = {
        id,
        accountUuid: profile.account.uuid,
        organizationUuid: profile.organization?.uuid,
        email: profile.account.email,
        label: existing?.label ?? (sameEmail && orgName ? `${profile.account.email} · ${orgName}` : profile.account.email),
        organizationName: orgName,
        subscriptionType: creds.claudeAiOauth.subscriptionType,
        enabled: existing?.enabled ?? true,
        priority: existing?.priority ?? d.accounts.reduce((m, a) => Math.max(m, a.priority), -1) + 1,
        addedAt: existing?.addedAt ?? Date.now(),
        oauthAccount,
        needsReauth: false,
      };
      if (existing) {
        Object.assign(existing, saved);
      } else {
        d.accounts.push(saved);
      }
      if (makeActive) {
        d.activeId = id;
      }
    });
    this.log.info(`Saved account ${saved.label}.`);
    return saved;
  }

  /** "Add current account" command. */
  async addCurrentAccount(): Promise<AccountMeta | undefined> {
    const creds = await readCredentials(this.paths);
    if (!creds) {
      return undefined;
    }
    let profile: Profile | undefined;
    if (creds.claudeAiOauth.expiresAt > Date.now() + 30_000) {
      profile = await fetchProfile(creds.claudeAiOauth.accessToken);
    } else {
      const oa = (await readGlobalConfig(this.paths))?.oauthAccount;
      if (oa && typeof oa.accountUuid === 'string' && typeof oa.emailAddress === 'string') {
        profile = {
          account: { uuid: oa.accountUuid, email: oa.emailAddress, display_name: oa.displayName as string | undefined },
          organization: oa.organizationUuid
            ? { uuid: oa.organizationUuid as string, name: oa.organizationName as string | undefined }
            : undefined,
        };
      }
    }
    if (!profile) {
      throw new Error('The current Claude Code login has expired. Send any message in Claude Code to refresh it, then try again.');
    }
    const meta = await this.mutex.run(() => this.saveAccount(creds, profile!, true));
    this.lastFingerprint = fingerprint(creds);
    this.unmanagedLogin = undefined;
    this.activeSince = Date.now();
    this.emitter.fire();
    void this.pollActive(true);
    return meta;
  }

  /**
   * Store an account obtained through the browser sign-in. Claude Code's current login is not
   * touched; the account simply joins the rotation (or gets fresh tokens if it was already there).
   */
  async addSignedInAccount(creds: CredentialsBlob, profile: Profile): Promise<{ meta: AccountMeta; isNew: boolean }> {
    const id = accountId(profile.account.uuid, profile.organization?.uuid);
    const isNew = !this.state.account(id);
    const meta = await this.mutex.run(() => this.saveAccount(creds, profile, false));
    this.emitter.fire();
    void this.pollAccount(id);
    return { meta, isNew };
  }

  /** Check one account's usage now. */
  async pollAccount(id: string): Promise<void> {
    if (id === this.state.current.activeId) {
      await this.pollActive(true);
      return;
    }
    const account = this.state.account(id);
    if (!account || this.disposed) {
      return;
    }
    await this.mutex.run(() => this.pollOneInactive(account));
    await this.evaluate();
  }

  // ───────────────────────────── switching ─────────────────────────────

  async switchTo(
    id: string,
    reason: string,
    opts: { automatic: boolean; overwriteUnmanaged?: boolean },
  ): Promise<boolean> {
    const switched = await this.mutex.run(async () => {
      const target = this.state.account(id);
      if (!target) {
        throw new Error('That account is no longer managed by ClaudeSwitch.');
      }
      const now = Date.now();
      const from = this.state.current.activeId;

      // 1. Save the outgoing login's latest tokens.
      const current = await readCredentials(this.paths);
      if (current) {
        const who = await this.identify(current);
        if (who?.id === id) {
          return false;
        }
        if (who && this.state.account(who.id)) {
          await this.vault.set(who.id, current);
        } else if (!opts.overwriteUnmanaged) {
          throw new UnmanagedLoginError(
            `The current Claude login${who?.email ? ` (${who.email})` : ''} isn't managed by ClaudeSwitch and would be lost.`,
          );
        }
      }

      // 2. Make sure the incoming login has a fresh access token.
      let creds = await this.vault.get(id);
      if (!creds) {
        await this.markNeedsReauth(id, 'No stored login.');
        throw new Error(`No stored login for ${target.label}. Sign in to it again from the ClaudeSwitch view.`);
      }
      if (creds.claudeAiOauth.expiresAt <= now + 5 * 60_000) {
        try {
          creds = { ...creds, claudeAiOauth: await refreshCredentials(creds.claudeAiOauth) };
          await this.vault.set(id, creds);
        } catch (err) {
          if (err instanceof ApiError && err.isAuthDead) {
            await this.markNeedsReauth(id, errorText(err));
            throw new Error(`${target.label}'s login has expired. Sign in to it again from the ClaudeSwitch view.`);
          }
          throw new Error(`Couldn't refresh ${target.label}'s login: ${errorText(err)}`);
        }
      }

      // 3. Hand it to Claude Code. Running sessions pick up the change on their next request.
      await writeCredentials(this.paths, creds);
      this.lastFingerprint = fingerprint(creds);
      if (target.oauthAccount) {
        try {
          await writeOAuthAccount(this.paths, target.oauthAccount);
        } catch (err) {
          this.log.warn(`Switched credentials but couldn't update ${this.paths.globalConfigFile}: ${errorText(err)}`);
        }
      }

      this.activeSince = now;
      this.unmanagedLogin = undefined;
      await this.state.update((d) => {
        d.activeId = id;
        d.lastSwitch = { from, to: id, reason, at: now, automatic: opts.automatic };
      });
      const fromLabel = this.state.account(from)?.label ?? 'unmanaged login';
      this.log.info(`${opts.automatic ? 'Auto-switched' : 'Switched'} ${fromLabel} → ${target.label}: ${reason}`);
      return true;
    });

    if (switched) {
      this.emitter.fire();
      setTimeout(() => void this.pollActive(true), 3000);
    }
    return switched;
  }

  private async markNeedsReauth(id: string, error: string): Promise<void> {
    await this.state.update((d) => {
      const a = d.accounts.find((x) => x.id === id);
      if (a) {
        a.needsReauth = true;
        a.lastError = error;
      }
    });
  }

  // ───────────────────────────── usage polling ─────────────────────────────

  /** Fetch usage for the active login with the token Claude Code holds (never refreshing it). */
  async pollActive(force = false, evaluateAfter = true): Promise<void> {
    if (this.disposed || (!force && !this.isLeader)) {
      return;
    }
    await this.mutex.run(async () => {
      const id = this.state.current.activeId;
      const now = Date.now();
      if (!id || (!force && (this.backoffUntil.get(id) ?? 0) > now)) {
        return;
      }
      const creds = await readCredentials(this.paths);
      if (!creds || creds.claudeAiOauth.expiresAt <= now + 60_000) {
        return; // Claude Code refreshes its own token; meanwhile its cached usage is used.
      }
      try {
        const raw = await fetchUsage(creds.claudeAiOauth.accessToken);
        const snapshot = normalizeUsage(raw, Date.now(), 'api');
        this.backoffUntil.delete(id);
        await this.state.update((d) => {
          d.usage[id] = snapshot;
          const a = d.accounts.find((x) => x.id === id);
          if (a) {
            a.lastError = undefined;
          }
        });
      } catch (err) {
        this.handlePollError(id, err);
      }
    });
    await this.ingestClaudeCache(false);
    if (evaluateAfter) {
      await this.evaluate();
    }
  }

  /** Fetch usage for every other account, refreshing their tokens when needed. */
  async pollInactive(force = false): Promise<void> {
    if (this.disposed || (!force && !this.isLeader)) {
      return;
    }
    for (const account of this.state.accounts()) {
      if (account.id === this.state.current.activeId || account.needsReauth) {
        continue;
      }
      if (!force && (this.backoffUntil.get(account.id) ?? 0) > Date.now()) {
        continue;
      }
      await this.mutex.run(() => this.pollOneInactive(account));
    }
    await this.evaluate();
  }

  private async pollOneInactive(account: AccountMeta): Promise<void> {
    let creds = await this.vault.get(account.id);
    if (!creds) {
      return;
    }
    const current = await readCredentials(this.paths);
    if (current && current.claudeAiOauth.refreshToken === creds.claudeAiOauth.refreshToken) {
      return; // It's actually the live login; Claude Code owns its token.
    }
    const now = Date.now();
    const accessExpiring = creds.claudeAiOauth.expiresAt <= now + 2 * 60_000;
    const refreshExpiring =
      creds.claudeAiOauth.refreshTokenExpiresAt !== undefined &&
      creds.claudeAiOauth.refreshTokenExpiresAt - now < REFRESH_TOKEN_RENEW_MS;
    if (accessExpiring || refreshExpiring) {
      if (!this.config.refreshInactiveTokens) {
        return;
      }
      try {
        creds = { ...creds, claudeAiOauth: await refreshCredentials(creds.claudeAiOauth) };
        await this.vault.set(account.id, creds);
      } catch (err) {
        if (err instanceof ApiError && err.isAuthDead) {
          this.log.warn(`${account.label}: stored login was rejected (${errorText(err)}). Sign in to it again.`);
          await this.markNeedsReauth(account.id, errorText(err));
        } else {
          this.handlePollError(account.id, err);
        }
        return;
      }
    }
    try {
      let raw: unknown;
      try {
        raw = await fetchUsage(creds.claudeAiOauth.accessToken);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 401) || !this.config.refreshInactiveTokens || accessExpiring) {
          throw err;
        }
        // Token rejected before its stated expiry: refresh once and retry.
        creds = { ...creds, claudeAiOauth: await refreshCredentials(creds.claudeAiOauth) };
        await this.vault.set(account.id, creds);
        raw = await fetchUsage(creds.claudeAiOauth.accessToken);
      }
      const snapshot = normalizeUsage(raw, Date.now(), 'api');
      this.backoffUntil.delete(account.id);
      await this.state.update((d) => {
        d.usage[account.id] = snapshot;
        const a = d.accounts.find((x) => x.id === account.id);
        if (a) {
          a.lastError = undefined;
        }
      });
    } catch (err) {
      this.handlePollError(account.id, err);
    }
  }

  private handlePollError(id: string, err: unknown): void {
    const label = this.state.account(id)?.label ?? id;
    const status = err instanceof ApiError ? err.status : undefined;
    const wait = status === 429 ? 10 * 60_000 : 2 * 60_000;
    this.backoffUntil.set(id, Date.now() + wait);
    this.log.warn(`${label}: usage check failed (${errorText(err)}).`);
    void this.state.update((d) => {
      const a = d.accounts.find((x) => x.id === id);
      if (a) {
        a.lastError = errorText(err);
      }
    });
  }

  /** Claude Code caches the active login's usage in its global config; use it when it's newer. */
  private async ingestClaudeCache(evaluateAfter = true): Promise<void> {
    if (this.disposed || !this.isLeader) {
      return;
    }
    const id = this.state.current.activeId;
    const account = this.state.account(id);
    if (!account) {
      return;
    }
    const cfg = await readGlobalConfig(this.paths);
    const cache = cfg?.cachedUsageUtilization;
    if (!cache?.utilization || cache.accountUuid !== account.accountUuid || typeof cache.fetchedAtMs !== 'number') {
      return;
    }
    const orgUuid = cfg?.oauthAccount?.organizationUuid;
    if (orgUuid && account.organizationUuid && orgUuid !== account.organizationUuid) {
      return;
    }
    // Older than the switch to this account: it may describe the previous login (same user, other org).
    if (cache.fetchedAtMs < this.activeSinceAny()) {
      return;
    }
    const existing = this.state.current.usage[account.id];
    if (existing && existing.fetchedAt >= cache.fetchedAtMs) {
      return;
    }
    const snapshot = normalizeUsage(cache.utilization, cache.fetchedAtMs, 'claude-cache');
    if (snapshot.windows.length === 0) {
      return;
    }
    await this.state.update((d) => {
      d.usage[account.id] = snapshot;
    });
    if (evaluateAfter) {
      await this.evaluate();
    }
  }

  private async onLimitEvent(e: LimitEvent): Promise<void> {
    const id = this.state.current.activeId;
    const account = this.state.account(id);
    if (!account || e.timestamp < this.activeSinceAny() - 1000) {
      return; // Before the current account became active — not its error.
    }
    const now = Date.now();
    if (now - this.lastLimitEventAt < 20_000) {
      return;
    }
    this.lastLimitEventAt = now;
    this.log.warn(`Claude Code reported a limit on ${account.label}: “${e.text || 'rate limited'}”`);
    await this.pollActive(true, false);
    const st = this.accountStates().find((s) => s.id === account.id);
    if (e.hardLimit && st && !st.exhausted) {
      // The usage endpoint doesn't show it (yet) — trust the error for a while.
      await this.state.update((d) => {
        d.limitedUntil[account.id] = now + FALLBACK_LIMIT_MS;
      });
    }
    await this.evaluate();
  }

  // ───────────────────────────── deciding ─────────────────────────────

  async evaluate(): Promise<void> {
    if (!this.isLeader || this.disposed) {
      return;
    }
    const now = Date.now();
    const s = this.state.current;
    const decision = decide({
      accounts: this.state.accounts().map((a) => ({
        id: a.id,
        label: a.label,
        enabled: a.enabled,
        usable: !a.needsReauth,
        priority: a.priority,
        usage: s.usage[a.id],
        limitedUntil: s.limitedUntil[a.id],
      })),
      activeId: s.activeId,
      now,
      lastSwitchAt: s.lastSwitch?.at,
      config: this.config,
    });
    this.lastDecision = decision;
    this.scheduleResetCheck();
    this.emitter.fire();

    if (decision.kind === 'switch') {
      const auto = this.config.autoSwitch && this.config.strategy !== 'manual';
      if (auto && now - this.lastAutoSwitchAt >= MIN_GAP_BETWEEN_AUTO_SWITCHES_MS) {
        this.lastAutoSwitchAt = now;
        const from = s.activeId;
        try {
          if (await this.switchTo(decision.to, decision.reason, { automatic: true })) {
            this.announceSwitch(from, decision.to, decision.reason);
          }
        } catch (err) {
          this.log.error(`Automatic switch failed: ${errorText(err)}`);
          if (!(err instanceof UnmanagedLoginError)) {
            void vscode.window.showWarningMessage(`ClaudeSwitch: automatic switch failed — ${errorText(err)}`);
          }
        }
      } else if (!auto && decision.urgent) {
        this.offerManualSwitch(decision.to, decision.reason);
      }
    } else if (decision.kind === 'exhausted') {
      const key = decision.nextAvailable?.at ?? 0;
      if (this.lastExhaustedNotice !== key) {
        this.lastExhaustedNotice = key;
        const next = decision.nextAvailable;
        const nextText = next ? ` ${this.state.account(next.id)?.label ?? 'An account'} is available again at ${formatClock(next.at, now)}.` : '';
        this.log.warn(`All accounts are at their limits.${nextText}`);
        void vscode.window.showWarningMessage(`ClaudeSwitch: every Claude account is at its limit.${nextText}`);
      }
    } else {
      this.lastExhaustedNotice = undefined;
    }
  }

  private announceSwitch(from: string | undefined, to: string, reason: string): void {
    if (!this.config.notifyOnSwitch) {
      return;
    }
    const label = this.state.account(to)?.label ?? to;
    const actions = from && this.state.account(from) ? ['Undo'] : [];
    void vscode.window
      .showInformationMessage(`ClaudeSwitch: switched to ${label} — ${reason}.`, ...actions)
      .then(async (choice) => {
        if (choice === 'Undo' && from) {
          try {
            await this.switchTo(from, 'undo', { automatic: false });
          } catch (err) {
            void vscode.window.showErrorMessage(`ClaudeSwitch: ${errorText(err)}`);
          }
        }
      });
  }

  private offeredManualFor?: string;
  private offerManualSwitch(to: string, reason: string): void {
    const key = `${this.state.current.activeId}->${to}`;
    if (this.offeredManualFor === key) {
      return;
    }
    this.offeredManualFor = key;
    const label = this.state.account(to)?.label ?? to;
    void vscode.window
      .showWarningMessage(`ClaudeSwitch: ${reason}. Switch to ${label}?`, 'Switch')
      .then(async (choice) => {
        if (choice === 'Switch') {
          try {
            await this.switchTo(to, reason, { automatic: false });
          } catch (err) {
            void vscode.window.showErrorMessage(`ClaudeSwitch: ${errorText(err)}`);
          }
        }
      });
  }

  /** Re-evaluate right after the next limit window resets, so a recovered account is used promptly. */
  private scheduleResetCheck(): void {
    clearTimeout(this.resetTimer);
    const now = Date.now();
    let next = Infinity;
    const s = this.state.current;
    for (const a of s.accounts) {
      for (const w of s.usage[a.id]?.windows ?? []) {
        if (w.resetsAt && w.resetsAt > now) {
          next = Math.min(next, w.resetsAt);
        }
      }
      const lim = s.limitedUntil[a.id];
      if (lim && lim > now) {
        next = Math.min(next, lim);
      }
    }
    if (!Number.isFinite(next)) {
      return;
    }
    const delay = Math.min(next - now + 30_000, 6 * 3600_000);
    this.resetTimer = setTimeout(() => {
      void (async () => {
        await this.pollInactive();
        await this.pollActive();
      })();
    }, delay);
  }

  // ───────────────────────────── leadership & config ─────────────────────────────

  private onLeadershipChange(isLeader: boolean): void {
    this.log.info(isLeader ? 'This window is now monitoring usage.' : 'Another window is monitoring usage.');
    this.stopLoops();
    if (isLeader) {
      this.startLoops();
    }
    this.emitter.fire();
  }

  private startLoops(): void {
    const c = this.config;
    this.timers.push(setInterval(() => void this.pollActive(), c.pollIntervalSeconds * 1000));
    this.timers.push(setInterval(() => void this.pollInactive(), c.inactivePollMinutes * 60_000));
    this.timers.push(
      setTimeout(() => {
        void (async () => {
          await this.pollActive();
          await this.pollInactive();
        })();
      }, 1500),
    );
    if (c.watchTranscripts) {
      this.transcripts = new TranscriptWatcher(
        this.paths.projectsDir,
        (e) => void this.onLimitEvent(e),
        (m) => this.log.warn(m),
      );
      this.transcripts.start();
    }
  }

  private stopLoops(): void {
    for (const t of this.timers.splice(0)) {
      clearInterval(t);
      clearTimeout(t);
    }
    clearTimeout(this.resetTimer);
    this.transcripts?.dispose();
    this.transcripts = undefined;
  }

  private onConfigChanged(): void {
    const before = this.config;
    this.config = readConfig();
    if (before.claudeConfigDir !== this.config.claudeConfigDir) {
      this.unwatchCredentialStore();
      this.paths = resolvePaths(this.config.claudeConfigDir);
      this.watchCredentialStore();
      void this.syncActive();
    }
    if (this.isLeader) {
      this.stopLoops();
      this.startLoops();
    }
    this.emitter.fire();
  }

  async setAutoSwitch(on: boolean): Promise<void> {
    await vscode.workspace.getConfiguration('claudeswitch').update('autoSwitch', on, vscode.ConfigurationTarget.Global);
  }

  // ───────────────────────────── account edits ─────────────────────────────

  async removeAccount(id: string): Promise<void> {
    await this.vault.delete(id);
    await this.state.update((d) => {
      d.accounts = d.accounts.filter((a) => a.id !== id);
      delete d.usage[id];
      delete d.limitedUntil[id];
      if (d.activeId === id) {
        d.activeId = undefined;
      }
    });
    await this.syncActive();
  }

  async renameAccount(id: string, label: string): Promise<void> {
    await this.state.update((d) => {
      const a = d.accounts.find((x) => x.id === id);
      if (a) {
        a.label = label;
      }
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.state.update((d) => {
      const a = d.accounts.find((x) => x.id === id);
      if (a) {
        a.enabled = enabled;
      }
    });
    await this.evaluate();
  }

  async move(id: string, delta: -1 | 1): Promise<void> {
    await this.state.update((d) => {
      const ordered = [...d.accounts].sort((a, b) => a.priority - b.priority);
      const i = ordered.findIndex((a) => a.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= ordered.length) {
        return;
      }
      [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
      ordered.forEach((a, idx) => (a.priority = idx));
    });
    await this.evaluate();
  }

  dispose(): void {
    this.disposed = true;
    this.stopLoops();
    this.unwatchCredentialStore();
    clearTimeout(this.credDebounce);
    this.lease.dispose();
    this.state.dispose();
    this.emitter.dispose();
  }
}
