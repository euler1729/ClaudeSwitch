import * as vscode from 'vscode';
import { LoginResult, LoginSession } from './oauth';

type Outcome = { code: string; source: 'callback' | 'manual' } | { error: Error } | undefined;

/**
 * Open the Claude sign-in page in the browser and wait for it to come back. A small input box
 * stays open meanwhile: it closes by itself when the browser returns, offers to reopen or copy
 * the link (e.g. for a private window when the browser is signed in to another account), and
 * accepts a pasted code when the browser can't reach VS Code. Returns undefined if cancelled.
 */
export async function signInWithBrowser(opts: { title: string; loginHint?: string }): Promise<LoginResult | undefined> {
  const session = await LoginSession.start({ loginHint: opts.loginHint });
  const input = vscode.window.createInputBox();
  try {
    // In a remote window the listener runs on the remote machine: ask VS Code to forward it.
    // If it can't be forwarded to the same localhost port, fall back to the code flow.
    let callbackReachable = true;
    if (vscode.env.remoteName) {
      try {
        const external = await vscode.env.asExternalUri(vscode.Uri.parse(`http://localhost:${session.listenerPort}/`));
        callbackReachable =
          external.scheme === 'http' &&
          (external.authority === `localhost:${session.listenerPort}` || external.authority === `127.0.0.1:${session.listenerPort}`);
      } catch {
        callbackReachable = false;
      }
    }

    let manual = !callbackReachable;
    const currentUrl = () => (manual ? session.manualUrl : session.automaticUrl);
    const openPage = () => vscode.env.openExternal(vscode.Uri.parse(currentUrl()));
    const showMode = () => {
      input.prompt = manual
        ? 'Sign in in your browser, then paste the code the page shows and press Enter.'
        : 'Sign in in your browser with the account you want to add. This box closes by itself when you finish.';
      input.placeholder = manual ? 'Paste the code from the sign-in page' : 'Waiting for sign-in…  (or paste a code here)';
    };

    const reopen: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('globe'), tooltip: 'Open the sign-in page again' };
    const copy: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('copy'),
      tooltip: 'Copy the sign-in link — paste it into a private window to sign in with a different account',
    };
    const useCode: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('key'),
      tooltip: "Sign in with a code instead (if the browser can't get back to VS Code)",
    };
    input.title = opts.title;
    input.ignoreFocusOut = true;
    input.buttons = manual ? [reopen, copy] : [reopen, copy, useCode];
    showMode();

    const outcome = await new Promise<Outcome>((resolve) => {
      session.callback.then(
        (code) => resolve({ code, source: 'callback' }),
        (error: Error) => resolve({ error }),
      );
      input.onDidAccept(() => {
        const value = input.value.trim();
        if (value) {
          resolve({ code: value, source: 'manual' });
        }
      });
      input.onDidHide(() => resolve(undefined));
      input.onDidTriggerButton((button) => {
        if (button === reopen) {
          void openPage();
        } else if (button === copy) {
          void vscode.env.clipboard.writeText(currentUrl());
          vscode.window.setStatusBarMessage('$(check) Sign-in link copied', 3000);
        } else if (button === useCode) {
          manual = true;
          input.buttons = [reopen, copy];
          showMode();
          void openPage();
        }
      });
      input.show();
      void openPage();
    });

    if (!outcome) {
      return undefined;
    }
    if ('error' in outcome) {
      throw outcome.error;
    }
    input.value = '';
    input.enabled = false;
    input.busy = true;
    input.placeholder = 'Finishing sign-in…';
    return await session.complete(outcome.code, outcome.source);
  } finally {
    input.dispose();
    session.close();
  }
}
