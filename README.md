<p align="center"><img src="media/icon.png" width="112" alt="ClaudeSwitch logo"></p>

# ClaudeSwitch — Claude Account Switcher for VS Code

ClaudeSwitch manages several Claude Code accounts. When the active account hits its usage limit, ClaudeSwitch moves Claude Code to another account automatically. It also chooses which account to use so that as little of each account's allowance as possible goes unused.

## How it works

- **Adding accounts.** Click **Add Claude Account**, and the Claude sign-in page opens in your browser. When you finish signing in, the browser returns to a temporary listener that ClaudeSwitch runs on `127.0.0.1`, and the account is saved. This is the same sign-in that `claude auth login` uses, but no terminal is needed. Adding an account doesn't change which account Claude Code is using.
- **Switching.** Claude Code keeps its login in `~/.claude/.credentials.json` (on macOS, in the Keychain). ClaudeSwitch keeps a copy of each account's login in VS Code's secret storage, which is your OS keychain. To switch, it writes the chosen login into Claude Code's credential store and updates the account shown in `~/.claude.json`. Claude Code reloads its credentials when that store changes, so running sessions use the new account from their next request. You don't need to restart anything.
- **Usage.** ClaudeSwitch reads the same usage numbers as Claude Code's `/usage`: the 5-hour session window and the weekly windows, with their reset times. It checks the active account every 2 minutes and the other accounts every 15 minutes. It also uses the usage data Claude Code caches itself.
- **Instant detection.** ClaudeSwitch watches Claude Code's session transcripts for messages such as "You've hit your session limit". When one appears, it switches within seconds instead of waiting for the next check.
- **Keeping logins valid.** Claude Code rotates the active account's tokens, and ClaudeSwitch saves the latest copy whenever that happens. For inactive accounts, ClaudeSwitch refreshes the tokens itself, so they stay signed in and their usage can still be checked. It never refreshes the active account's token, because Claude Code manages that one.
- **Several windows.** With more than one VS Code window open, one window monitors usage and switches accounts. If that window closes, another one takes over.

## Choosing an account (strategies)

Each account's weekly allowance resets on its own schedule, and whatever is unused at reset is lost. Switching also has a cost. The prompt cache belongs to one account, so the first request after a switch sends the whole conversation again without the cache, and that uses more of the limit.

| Strategy | Behavior |
|---|---|
| **Efficient** (default) | Uses the account whose weekly limit resets soonest, because its leftover allowance expires first. It stays on an account until that account reaches `switchThreshold` (95%). It switches earlier only when another account has at least 25 points of weekly allowance that will expire within 24 hours. |
| **Balanced** | Keeps every account at a similar weekly usage level. It switches when the active account is 20 or more points ahead of the least-used one. |
| **Sequential** | Uses accounts in the order listed. When one is exhausted, it moves to the next. When a higher account resets, it moves back to it. |
| **Manual** | Never switches on its own. When the active account is exhausted, it shows which account to switch to. |

All strategies follow the same rules:
- An exhausted account is never chosen. An account that is excluded from rotation or needs you to log in again is never chosen automatically.
- An account with less than 10 points of room left is only chosen when no other account is available.
- Apart from switches caused by an exhausted account, ClaudeSwitch waits at least `minMinutesBetweenSwitches` (30) between switches.
- When every account is exhausted, ClaudeSwitch tells you once when the next account becomes available. It switches to that account when its limit resets.

## Setup

1. Install the extension:
   ```sh
   npm install && npm run package
   code --install-extension claudeswitch-0.2.0.vsix
   ```
2. Open the **ClaudeSwitch** view in the Activity Bar and click **Add Claude Account**.
3. Sign in in the browser window that opens. A small box in VS Code waits for you, and it closes by itself when sign-in is done. Repeat for each account.

If Claude Code is already signed in, **Add that login** (in the empty view) or **ClaudeSwitch: Add Current Claude Code Login** saves that account without a browser.

**Adding a second account when your browser is already signed in to claude.ai:** the sign-in page uses whichever account the browser is signed in to. To add a different one, click the copy button in the waiting box and paste the link into a private window. You can also sign out of claude.ai in the browser first. If you sign in to an account that's already added, ClaudeSwitch tells you, and it renews that account's saved login.

**Remote, WSL, Codespaces or browser-based VS Code:** if the browser can't reach VS Code's machine, click the key button in the waiting box. The sign-in page then shows a code, which you paste into the box. ClaudeSwitch switches to this mode automatically when it can't forward the listener's port.

## Using it

- **Status bar.** Shows the active account with its usage, for example `⇄ alice · 5h 42% · wk 31%`. It turns yellow at `warnThreshold` and red when the account is exhausted. Hover over it to see a table of all accounts. Click it to switch.
- **Accounts view.** Lists each account with its usage windows, reset times, and any login problems. Right-click an account to rename it, exclude it from rotation, change its order, or remove it.
- **Commands.** `ClaudeSwitch: Switch Claude Account…`, `Switch to Best Available Account`, `Refresh Usage`, `Toggle Automatic Switching`, `Show Log`.
- **After an automatic switch,** a notification names the new account, gives the reason, and offers **Undo**.
- **If an account's saved login stops working** (for example, after you sign out of it everywhere), it's marked **Sign in again**. Click it to sign in through the browser again.

## Settings

| Setting | Default | |
|---|---|---|
| `claudeswitch.autoSwitch` | `true` | Switch automatically. |
| `claudeswitch.strategy` | `efficient` | `efficient`, `balanced`, `sequential` or `manual`. |
| `claudeswitch.switchThreshold` | `95` | Usage percentage at which an account counts as exhausted. |
| `claudeswitch.warnThreshold` | `80` | Usage percentage at which the status bar turns yellow. |
| `claudeswitch.proactiveSwitching` | `true` | Efficient strategy: switch early to use allowance that is about to expire. |
| `claudeswitch.proactiveHorizonHours` | `24` | Efficient strategy: how close to its reset another account must be for an early switch. |
| `claudeswitch.proactiveMinHeadroom` | `25` | Efficient strategy: weekly points the other account must have left for an early switch. |
| `claudeswitch.balanceMargin` | `20` | Balanced strategy: usage gap that triggers a switch. |
| `claudeswitch.minMinutesBetweenSwitches` | `30` | Minimum time between switches that no exhausted account forces. |
| `claudeswitch.pollIntervalSeconds` | `120` | How often the active account's usage is checked. |
| `claudeswitch.inactivePollMinutes` | `15` | How often the other accounts' usage is checked. |
| `claudeswitch.refreshInactiveTokens` | `true` | Keep inactive accounts signed in by refreshing their tokens. |
| `claudeswitch.watchTranscripts` | `true` | React to limit errors in Claude Code transcripts immediately. |
| `claudeswitch.autoAddNewLogins` | `true` | Add any new Claude Code login automatically. |
| `claudeswitch.notifyOnSwitch` | `true` | Show a notification on each switch. |
| `claudeswitch.claudeConfigDir` | `""` | Claude Code's config folder. Defaults to `CLAUDE_CONFIG_DIR`, or `~/.claude` if that isn't set. |

## Limitations

- ClaudeSwitch works with Claude subscription logins (Pro, Max, Team or Enterprise). It does not handle API keys.
- It relies on Claude Code's credential files and its usage endpoint, which aren't public APIs. A future Claude Code release could change them. If switching stops working, check **ClaudeSwitch: Show Log**.
- If a running Claude Code process rewrites `~/.claude.json` at the moment ClaudeSwitch switches, `/status` may briefly show the previous email. Requests still use the new account, because they authenticate with the credential store.
- Usage on claude.ai counts toward the same limits. ClaudeSwitch notices that usage at its next check of that account.
- Each account is subject to its own plan's terms. Only add accounts you are entitled to use.

## Development

```sh
npm install
npm test          # compiles, then runs unit and integration tests (Node's built-in runner)
npm run watch     # recompile on change; press F5 in VS Code to launch an Extension Development Host
npm run package   # builds claudeswitch-0.2.0.vsix
```

The integration test runs the real controller against a temporary Claude config folder and a fake API server. That includes the browser sign-in, with a simulated browser visiting the callback. It never touches your `~/.claude`.

### Releasing

1. Update `version` in `package.json`, and add a matching `## <version>` section at the top of `CHANGELOG.md`.
2. Commit, then tag and push: `git tag v<version> && git push origin main v<version>`.

The Release workflow runs the tests, builds the `.vsix`, and publishes a GitHub release. The notes come from that version's CHANGELOG section, and the release includes install steps and SHA-256 checksums.

| File | Role |
|---|---|
| `src/strategy.ts` | Chooses which account to use. Pure functions, unit-tested. |
| `src/usage.ts` | Parses the usage response. |
| `src/controller.ts` | Detects the active login, polls usage, refreshes tokens, switches accounts, and elects the monitoring window. |
| `src/claude.ts` | Reads and writes Claude Code's credential store and `~/.claude.json`. |
| `src/api.ts` | Calls the usage, profile and token endpoints. |
| `src/oauth.ts` | Runs the browser sign-in: PKCE, the authorize URL and the local callback listener. |
| `src/signIn.ts` | Shows the box that waits for sign-in, with reopen, copy-link and paste-a-code options. |
| `src/transcripts.ts` | Detects limit errors in session transcripts. |
| `src/ui.ts`, `src/extension.ts` | Status bar, accounts view and commands. |
