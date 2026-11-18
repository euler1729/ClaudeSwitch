import * as vscode from 'vscode';
import { Controller } from './controller';
import { formatClock, formatDuration, pct, percentBar } from './format';
import { AccountState } from './strategy';
import { AccountMeta } from './types';
import { currentPercent, headline } from './usage';

const STRATEGY_NAMES: Record<string, string> = {
  efficient: 'Efficient',
  balanced: 'Balanced',
  sequential: 'Sequential',
  manual: 'Manual',
};

export function shortName(label: string): string {
  const base = label.includes('@') ? label.split('@')[0] : label;
  return base.length > 18 ? `${base.slice(0, 17)}…` : base;
}

/** "5h 42% · wk 31%" */
export function usageSummary(c: Controller, id: string, now: number): string {
  const h = headline(c.state.current.usage[id], now);
  const parts: string[] = [];
  if (h.session) {
    parts.push(`5h ${pct(h.session.current)}`);
  }
  if (h.weekly) {
    parts.push(`wk ${pct(h.weekly.current)}`);
  }
  return parts.length ? parts.join(' · ') : 'usage not checked yet';
}

export function accountStatus(c: Controller, st: AccountState, meta: AccountMeta, now: number): string {
  if (meta.needsReauth) {
    return 'needs login';
  }
  if (st.exhausted) {
    return st.availableAt ? `limit reached · back in ${formatDuration(st.availableAt - now)}` : 'limit reached';
  }
  const summary = usageSummary(c, meta.id, now);
  return meta.enabled ? summary : `${summary} · excluded`;
}

function modeText(c: Controller): string {
  const cfg = c.settings;
  const auto = cfg.autoSwitch && cfg.strategy !== 'manual';
  return `${STRATEGY_NAMES[cfg.strategy] ?? cfg.strategy} · ${auto ? 'auto-switch on' : 'auto-switch off'}`;
}

// ───────────────────────────── status bar ─────────────────────────────

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('claudeswitch.status', vscode.StatusBarAlignment.Right, 100);
  private readonly timer: NodeJS.Timeout;
  private readonly sub: vscode.Disposable;

  constructor(private readonly c: Controller) {
    this.item.name = 'ClaudeSwitch';
    this.sub = c.onDidChange(() => this.render());
    this.timer = setInterval(() => this.render(), 60_000);
    this.render();
    this.item.show();
  }

  render(): void {
    const c = this.c;
    const now = Date.now();
    const cfg = c.settings;
    const activeId = c.state.current.activeId;
    const states = c.accountStates(now);
    const active = states.find((s) => s.id === activeId);
    const auto = cfg.autoSwitch && cfg.strategy !== 'manual';
    this.item.backgroundColor = undefined;
    this.item.command = 'claudeswitch.switchAccount';

    if (states.length === 0) {
      this.item.text = '$(person-add) ClaudeSwitch';
      this.item.tooltip = 'ClaudeSwitch: add your Claude accounts to switch between them automatically.';
      this.item.command = 'claudeswitch.addCurrentAccount';
      return;
    }
    if (!active) {
      const who = c.unmanagedLogin?.email;
      this.item.text = `$(question) ${who ? shortName(who) : 'Claude: not logged in'}`;
      this.item.tooltip = this.tooltip(states, now, who ? `Current login **${who}** isn't managed by ClaudeSwitch.` : 'Claude Code has no subscription login.');
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }

    const meta = c.state.account(active.id)!;
    this.item.text = `${auto ? '$(arrow-swap)' : '$(account)'} ${shortName(meta.label)} · ${usageSummary(c, active.id, now)}`;
    if (active.exhausted) {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (active.maxPercent >= cfg.warnThreshold) {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    this.item.tooltip = this.tooltip(states, now);
  }

  private tooltip(states: AccountState[], now: number, note?: string): vscode.MarkdownString {
    const c = this.c;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ['claudeswitch.switchAccount', 'claudeswitch.refreshUsage', 'claudeswitch.addCurrentAccount'] };
    md.appendMarkdown(`**ClaudeSwitch** — ${modeText(c)}\n\n`);
    if (note) {
      md.appendMarkdown(`${note}\n\n`);
    }
    md.appendMarkdown('| | Account | 5h | Weekly | Weekly resets |\n|:-:|---|--:|--:|---|\n');
    for (const st of states) {
      const meta = c.state.account(st.id)!;
      const h = headline(c.state.current.usage[st.id], now);
      const mark = st.id === c.state.current.activeId ? '$(check)' : meta.needsReauth ? '$(warning)' : st.exhausted ? '$(error)' : '';
      const resets = h.weekly?.resetsAt && h.weekly.resetsAt > now ? formatClock(h.weekly.resetsAt, now) : '—';
      md.appendMarkdown(
        `| ${mark} | ${escapeMd(meta.label)}${meta.enabled ? '' : ' *(excluded)*'} | ${h.session ? pct(h.session.current) : '—'} | ${h.weekly ? pct(h.weekly.current) : '—'} | ${resets} |\n`,
      );
    }
    const last = c.state.current.lastSwitch;
    if (last) {
      const from = c.state.account(last.from)?.label ?? 'another login';
      const to = c.state.account(last.to)?.label ?? 'an account';
      md.appendMarkdown(
        `\nLast switch ${formatDuration(now - last.at)} ago: ${escapeMd(from)} → ${escapeMd(to)} (${escapeMd(last.reason)})\n`,
      );
    }
    md.appendMarkdown('\n[$(arrow-swap) Switch account](command:claudeswitch.switchAccount) · [$(refresh) Refresh](command:claudeswitch.refreshUsage)');
    return md;
  }

  dispose(): void {
    clearInterval(this.timer);
    this.sub.dispose();
    this.item.dispose();
  }
}

function escapeMd(s: string): string {
  return s.replace(/[|\\`*_[\]<>]/g, (ch) => `\\${ch}`);
}

// ───────────────────────────── tree view ─────────────────────────────

export type TreeNode =
  | { kind: 'account'; id: string }
  | { kind: 'unmanaged'; email?: string }
  | {
      kind: 'detail';
      key: string;
      label: string;
      description?: string;
      icon?: vscode.ThemeIcon;
      tooltip?: string;
      command?: vscode.Command;
    };

export class AccountsTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly timer: NodeJS.Timeout;
  private readonly sub: vscode.Disposable;

  constructor(private readonly c: Controller) {
    this.sub = c.onDidChange(() => this.emitter.fire(undefined));
    this.timer = setInterval(() => this.emitter.fire(undefined), 60_000);
  }

  get description(): string {
    return modeText(this.c);
  }

  getChildren(node?: TreeNode): TreeNode[] {
    const c = this.c;
    if (!node) {
      const nodes: TreeNode[] = [];
      if (!c.state.current.activeId && c.unmanagedLogin) {
        nodes.push({ kind: 'unmanaged', email: c.unmanagedLogin.email });
      }
      for (const a of c.state.accounts()) {
        nodes.push({ kind: 'account', id: a.id });
      }
      return nodes;
    }
    if (node.kind !== 'account') {
      return [];
    }
    return this.details(node.id);
  }

  private details(id: string): TreeNode[] {
    const c = this.c;
    const now = Date.now();
    const meta = c.state.account(id);
    if (!meta) {
      return [];
    }
    const out: TreeNode[] = [];
    const usage = c.state.current.usage[id];
    if (meta.needsReauth) {
      out.push({
        kind: 'detail',
        key: `${id}:reauth`,
        label: 'Sign in again to use this account',
        description: 'click to open the sign-in page',
        icon: new vscode.ThemeIcon('sign-in', new vscode.ThemeColor('list.warningForeground')),
        tooltip: `The saved login stopped working${meta.lastError ? ` (${meta.lastError})` : ''}. Click to sign in again in your browser.`,
        command: { command: 'claudeswitch.signInAgain', title: 'Sign In Again', arguments: [id] },
      });
    }
    if (usage) {
      for (const w of usage.windows) {
        const p = currentPercent(w, now);
        const resets =
          w.resetsAt && w.resetsAt > now ? ` · resets in ${formatDuration(w.resetsAt - now)} (${formatClock(w.resetsAt, now)})` : '';
        out.push({
          kind: 'detail',
          key: `${id}:${w.key}`,
          label: w.label,
          description: `${percentBar(p)} ${pct(p)}${resets}`,
          icon: new vscode.ThemeIcon(w.group === 'session' ? 'clock' : 'calendar', colorFor(p, c.settings.warnThreshold, c.settings.switchThreshold)),
        });
      }
      out.push({
        kind: 'detail',
        key: `${id}:updated`,
        label: `Updated ${formatDuration(now - usage.fetchedAt)} ago`,
        description: usage.source === 'api' ? undefined : 'from Claude Code',
        icon: new vscode.ThemeIcon('history'),
      });
    } else if (!meta.needsReauth) {
      out.push({ kind: 'detail', key: `${id}:nodata`, label: 'Usage not checked yet', icon: new vscode.ThemeIcon('loading~spin') });
    }
    const limited = c.state.current.limitedUntil[id];
    if (limited && limited > now) {
      out.push({
        kind: 'detail',
        key: `${id}:limited`,
        label: 'Claude Code reported a usage limit',
        description: `treated as exhausted for ${formatDuration(limited - now)}`,
        icon: new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground')),
      });
    }
    if (meta.lastError && !meta.needsReauth) {
      out.push({
        kind: 'detail',
        key: `${id}:error`,
        label: 'Last check failed',
        description: meta.lastError,
        icon: new vscode.ThemeIcon('warning'),
      });
    }
    const plan = [meta.subscriptionType, meta.organizationName].filter(Boolean).join(' · ');
    if (plan) {
      out.push({ kind: 'detail', key: `${id}:plan`, label: plan, icon: new vscode.ThemeIcon('organization') });
    }
    return out;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const c = this.c;
    if (node.kind === 'detail') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.id = node.key;
      item.description = node.description;
      item.iconPath = node.icon;
      item.tooltip = node.tooltip;
      item.command = node.command;
      return item;
    }
    if (node.kind === 'unmanaged') {
      const item = new vscode.TreeItem(node.email ?? 'Current Claude login', vscode.TreeItemCollapsibleState.None);
      item.id = 'unmanaged';
      item.description = 'current login · not managed — click to add';
      item.iconPath = new vscode.ThemeIcon('question', new vscode.ThemeColor('list.warningForeground'));
      item.command = { command: 'claudeswitch.addCurrentAccount', title: 'Add Current Account' };
      return item;
    }

    const now = Date.now();
    const meta = c.state.account(node.id);
    const st = c.accountStates(now).find((s) => s.id === node.id);
    if (!meta || !st) {
      return new vscode.TreeItem('(removed)');
    }
    const isActive = c.state.current.activeId === node.id;
    const item = new vscode.TreeItem(
      meta.label,
      isActive ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = `account:${node.id}`;
    const status = accountStatus(c, st, meta, now);
    item.description = isActive ? `active · ${status}` : status;
    item.contextValue = `account:${isActive ? 'active' : 'inactive'}${meta.enabled ? '' : ':disabled'}${meta.needsReauth ? ':reauth' : ''}`;
    const color = colorFor(st.maxPercent, c.settings.warnThreshold, c.settings.switchThreshold);
    if (meta.needsReauth) {
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    } else if (st.exhausted) {
      item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
    } else if (isActive) {
      item.iconPath = new vscode.ThemeIcon('pass-filled', color);
    } else if (!meta.enabled) {
      item.iconPath = new vscode.ThemeIcon('circle-slash');
    } else {
      item.iconPath = new vscode.ThemeIcon('circle-large-outline', color);
    }
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${escapeMd(meta.label)}**${isActive ? ' — active' : ''}\n\n`);
    md.appendMarkdown(`${escapeMd(meta.email)}${meta.organizationName ? ` · ${escapeMd(meta.organizationName)}` : ''}\n\n`);
    md.appendMarkdown(meta.enabled ? 'Included in automatic switching.' : 'Excluded from automatic switching.');
    item.tooltip = md;
    return item;
  }

  dispose(): void {
    clearInterval(this.timer);
    this.sub.dispose();
    this.emitter.dispose();
  }
}

function colorFor(percent: number, warn: number, limit: number): vscode.ThemeColor | undefined {
  if (percent >= limit) {
    return new vscode.ThemeColor('charts.red');
  }
  if (percent >= warn) {
    return new vscode.ThemeColor('charts.yellow');
  }
  return new vscode.ThemeColor('charts.green');
}
