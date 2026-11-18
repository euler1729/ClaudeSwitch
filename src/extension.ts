import * as vscode from 'vscode';
import { subscriptionTypeFor } from './api';
import { Controller, UnmanagedLoginError } from './controller';
import { formatDuration } from './format';
import { signInWithBrowser } from './signIn';
import { rankCandidates } from './strategy';
import { AccountsTree, StatusBar, TreeNode, accountStatus } from './ui';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('ClaudeSwitch', { log: true });
  const c = new Controller(context, log);
  const tree = new AccountsTree(c);
  const view = vscode.window.createTreeView('claudeswitch.accounts', { treeDataProvider: tree });
  const updateViewDescription = () => (view.description = tree.description);
  updateViewDescription();
  context.subscriptions.push(log, c, tree, view, new StatusBar(c), c.onDidChange(updateViewDescription));

  const register = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: any[]) => {
        try {
          await fn(...args);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`${id}: ${msg}`);
          void vscode.window.showErrorMessage(`ClaudeSwitch: ${msg}`);
        }
      }),
    );

  register('claudeswitch.addCurrentAccount', () => addCurrentAccount(c));
  register('claudeswitch.addAccount', () => addAccount(c));
  register('claudeswitch.signInAgain', async (arg?: TreeNode | string) => {
    const id = idFrom(arg) ?? (await pickAccount(c, 'Sign in again to which account?'));
    if (id) {
      await addAccount(c, id);
    }
  });
  register('claudeswitch.switchAccount', (arg?: TreeNode) => switchAccount(c, idFrom(arg)));
  register('claudeswitch.switchToBest', () => switchToBest(c));
  register('claudeswitch.refreshUsage', () => refreshUsage(c));
  register('claudeswitch.toggleAutoSwitch', async () => {
    const on = !c.settings.autoSwitch;
    await c.setAutoSwitch(on);
    vscode.window.setStatusBarMessage(`$(sync) ClaudeSwitch: automatic switching ${on ? 'on' : 'off'}`, 4000);
  });
  register('claudeswitch.renameAccount', async (arg?: TreeNode) => {
    const id = idFrom(arg) ?? (await pickAccount(c, 'Rename which account?'));
    const meta = c.state.account(id);
    if (!meta) {
      return;
    }
    const label = await vscode.window.showInputBox({ prompt: 'Display name', value: meta.label });
    if (label?.trim()) {
      await c.renameAccount(meta.id, label.trim());
    }
  });
  register('claudeswitch.toggleAccountEnabled', async (arg?: TreeNode) => {
    const id = idFrom(arg) ?? (await pickAccount(c, 'Include or exclude which account?'));
    const meta = c.state.account(id);
    if (meta) {
      await c.setEnabled(meta.id, !meta.enabled);
    }
  });
  register('claudeswitch.moveAccountUp', async (arg?: TreeNode) => {
    const id = idFrom(arg);
    if (id) {
      await c.move(id, -1);
    }
  });
  register('claudeswitch.moveAccountDown', async (arg?: TreeNode) => {
    const id = idFrom(arg);
    if (id) {
      await c.move(id, 1);
    }
  });
  register('claudeswitch.removeAccount', async (arg?: TreeNode) => {
    const id = idFrom(arg) ?? (await pickAccount(c, 'Remove which account?'));
    const meta = c.state.account(id);
    if (!meta) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Remove ${meta.label} from ClaudeSwitch?`,
      { modal: true, detail: 'ClaudeSwitch deletes its saved copy of this login. Your current Claude Code login is not changed.' },
      'Remove',
    );
    if (ok === 'Remove') {
      await c.removeAccount(meta.id);
    }
  });
  register('claudeswitch.showLog', () => log.show());
  register('claudeswitch.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'claudeswitch.'));

  await c.start();
  void offerFirstAccount(context, c);
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}

function idFrom(arg: unknown): string | undefined {
  if (typeof arg === 'string') {
    return arg;
  }
  const node = arg as TreeNode | undefined;
  return node?.kind === 'account' ? node.id : undefined;
}

async function pickAccount(c: Controller, title: string): Promise<string | undefined> {
  const now = Date.now();
  const states = c.accountStates(now);
  const picked = await vscode.window.showQuickPick(
    states.map((st) => {
      const meta = c.state.account(st.id)!;
      return { label: meta.label, description: accountStatus(c, st, meta, now), id: st.id };
    }),
    { title },
  );
  return picked?.id;
}

async function addCurrentAccount(c: Controller): Promise<void> {
  const meta = await c.addCurrentAccount();
  if (!meta) {
    const choice = await vscode.window.showWarningMessage(
      'ClaudeSwitch: Claude Code isn\'t signed in to a Claude subscription right now. Add an account by signing in through your browser instead.',
      'Add Account',
    );
    if (choice === 'Add Account') {
      await addAccount(c);
    }
    return;
  }
  void vscode.window.showInformationMessage(`ClaudeSwitch: added ${meta.label}.`);
}

/**
 * Add an account (or renew one whose login stopped working) by signing in through the browser.
 * Claude Code's current login is left as it is.
 */
async function addAccount(c: Controller, reauthId?: string): Promise<void> {
  const target = c.state.account(reauthId);
  const result = await signInWithBrowser({
    title: target ? `ClaudeSwitch: sign in again as ${target.label}` : 'ClaudeSwitch: add a Claude account',
    loginHint: target?.email,
  });
  if (!result) {
    return;
  }
  const { meta, isNew } = await c.addSignedInAccount(result.creds, result.profile);
  const browserHint = 'To use a different account, sign out of claude.ai in your browser, or copy the sign-in link into a private window.';

  if (target && meta.id !== target.id) {
    void vscode.window.showWarningMessage(
      `ClaudeSwitch: you signed in as ${meta.label}, not ${target.label}.${isNew ? ` ${meta.label} was added as a new account.` : ''} ${browserHint}`,
    );
    return;
  }
  if (!target && !isNew) {
    const choice = await vscode.window.showInformationMessage(
      `ClaudeSwitch: ${meta.label} is already added, so its saved login was just renewed. ${browserHint}`,
      'Add Another',
    );
    if (choice === 'Add Another') {
      await addAccount(c);
    }
    return;
  }

  if (!subscriptionTypeFor(result.profile.organization?.organization_type)) {
    void vscode.window.showWarningMessage(
      `ClaudeSwitch: ${meta.label} doesn't appear to have a Claude Pro, Max, Team or Enterprise plan, so Claude Code may not accept it.`,
    );
  }
  const actions: string[] = [];
  if (c.state.current.activeId !== meta.id) {
    actions.push('Use Now');
  }
  if (!target) {
    actions.push('Add Another');
  }
  const message = target
    ? `ClaudeSwitch: ${meta.label} is signed in again.`
    : c.state.current.activeId
      ? `ClaudeSwitch: added ${meta.label}. It will be used when it's the best account for the job.`
      : `ClaudeSwitch: added ${meta.label}.`;
  const choice = await vscode.window.showInformationMessage(message, ...actions);
  if (choice === 'Use Now') {
    await performSwitch(c, meta.id, 'switched manually');
  } else if (choice === 'Add Another') {
    await addAccount(c);
  }
}

async function switchAccount(c: Controller, id?: string): Promise<void> {
  if (!id) {
    const now = Date.now();
    const activeId = c.state.current.activeId;
    type Item = vscode.QuickPickItem & { id?: string; action?: 'login' };
    const items: Item[] = c.accountStates(now).map((st) => {
      const meta = c.state.account(st.id)!;
      return {
        label: `${st.id === activeId ? '$(check)' : st.exhausted || meta.needsReauth ? '$(error)' : '$(account)'} ${meta.label}`,
        description: accountStatus(c, st, meta, now),
        detail: st.id === activeId ? 'Active' : undefined,
        id: st.id,
      };
    });
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(add) Add account…', action: 'login' });
    const picked = await vscode.window.showQuickPick(items, { title: 'Switch Claude account' });
    if (!picked) {
      return;
    }
    if (picked.action === 'login') {
      return addAccount(c);
    }
    id = picked.id;
  }
  if (id) {
    await performSwitch(c, id, 'switched manually');
  }
}

async function switchToBest(c: Controller): Promise<void> {
  const ranked = rankCandidates(c.accountStates(), c.settings.strategy, Date.now());
  const best = ranked[0];
  if (!best) {
    void vscode.window.showWarningMessage('ClaudeSwitch: no account has capacity left right now.');
    return;
  }
  if (best.id === c.state.current.activeId) {
    void vscode.window.showInformationMessage(`ClaudeSwitch: ${best.label} is already the best account to use.`);
    return;
  }
  await performSwitch(c, best.id, 'best available account');
}

async function performSwitch(c: Controller, id: string, reason: string): Promise<void> {
  const meta = c.state.account(id);
  if (!meta) {
    return;
  }
  const now = Date.now();
  const st = c.accountStates(now).find((s) => s.id === id);
  if (st?.exhausted && id !== c.state.current.activeId) {
    const when = st.availableAt ? ` It resets in ${formatDuration(st.availableAt - now)}.` : '';
    const ok = await vscode.window.showWarningMessage(`${meta.label} is at its limit.${when} Switch anyway?`, { modal: true }, 'Switch');
    if (ok !== 'Switch') {
      return;
    }
  }
  let switched: boolean;
  try {
    switched = await c.switchTo(id, reason, { automatic: false });
  } catch (err) {
    if (!(err instanceof UnmanagedLoginError)) {
      throw err;
    }
    const choice = await vscode.window.showWarningMessage(
      err.message,
      { modal: true, detail: 'Add it to ClaudeSwitch first so you can switch back to it later.' },
      'Add It, Then Switch',
      'Switch Anyway',
    );
    if (!choice) {
      return;
    }
    if (choice === 'Add It, Then Switch') {
      await c.addCurrentAccount();
    }
    switched = await c.switchTo(id, reason, { automatic: false, overwriteUnmanaged: choice === 'Switch Anyway' });
  }
  if (switched) {
    vscode.window.setStatusBarMessage(`$(check) Claude account: ${meta.label}`, 5000);
  } else {
    vscode.window.setStatusBarMessage(`$(info) ${meta.label} is already active`, 4000);
  }
}

async function refreshUsage(c: Controller): Promise<void> {
  await vscode.window.withProgress(
    { location: { viewId: 'claudeswitch.accounts' }, title: 'Checking usage' },
    async () => {
      await c.syncActive();
      await c.pollActive(true);
      await c.pollInactive(true);
    },
  );
}

async function offerFirstAccount(context: vscode.ExtensionContext, c: Controller): Promise<void> {
  if (c.state.accounts().length > 0 || !c.unmanagedLogin?.email || context.globalState.get('claudeswitch.firstRunDismissed')) {
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `ClaudeSwitch: add ${c.unmanagedLogin.email} so it can be rotated with your other Claude accounts?`,
    'Add Account',
    'Not Now',
  );
  if (choice === 'Add Account') {
    await vscode.commands.executeCommand('claudeswitch.addCurrentAccount');
  } else if (choice === 'Not Now') {
    await context.globalState.update('claudeswitch.firstRunDismissed', true);
  }
}
