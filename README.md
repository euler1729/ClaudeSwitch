<p align="center">
  <img src="media/icon.png" width="128" alt="ClaudeSwitch logo">
</p>

<h1 align="center">ClaudeSwitch</h1>

<p align="center">
  <b>Hit a Claude Code usage limit? Keep working on your next account.</b><br>
  ClaudeSwitch rotates Claude Code between your Claude accounts automatically,<br>
  and picks the account whose unused allowance would otherwise go to waste.
</p>

<p align="center">
  <a href="https://github.com/euler1729/ClaudeSwitch/releases/latest"><img src="https://img.shields.io/github/v/release/euler1729/ClaudeSwitch?color=D77757&label=release" alt="Latest release"></a>
  <a href="https://github.com/euler1729/ClaudeSwitch/actions/workflows/ci.yml"><img src="https://github.com/euler1729/ClaudeSwitch/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/VS%20Code-1.90%2B-007ACC?logo=visualstudiocode&logoColor=white" alt="VS Code 1.90+">
  <img src="https://img.shields.io/badge/tested%20on-macOS%20%7C%20Linux-555" alt="Tested on macOS and Linux">
</p>

<p align="center">
  <a href="#quick-start"><b>Install</b></a> ·
  <a href="https://github.com/euler1729/ClaudeSwitch/releases/latest">Releases</a> ·
  <a href="#choosing-an-account">Strategies</a> ·
  <a href="#settings">Settings</a> ·
  <a href="https://github.com/euler1729/ClaudeSwitch/blob/main/CHANGELOG.md">Changelog</a>
</p>

### Install or update

```sh
curl -fsSL https://raw.githubusercontent.com/euler1729/ClaudeSwitch/main/install.sh | bash
```

<sub>One command for macOS and Linux. Run it again any time to update. Other ways to install are in the <a href="#quick-start">Quick start</a>.</sub>

<br>

```text
⇄ alice · 5h 42% · wk 31%          ← your status bar: active account, 5-hour and weekly usage
```

## Why ClaudeSwitch

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>🔄 Switches for you</h3>
      Moves Claude Code to another account when the active one reaches its 5-hour or weekly limit, or the moment a limit error shows up in a session.
    </td>
    <td width="50%" valign="top">
      <h3>🧠 Wastes nothing</h3>
      Uses the account whose weekly allowance resets soonest, so leftover capacity is spent before it expires instead of after.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>⚡ No restarts</h3>
      Running Claude Code sessions pick up the new account on their next request. Nothing to reload, nothing to log out of.
    </td>
    <td width="50%" valign="top">
      <h3>🔐 Browser sign-in</h3>
      Add accounts through the normal Claude sign-in page. Adding one never changes the account Claude Code is using.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>📊 Usage at a glance</h3>
      Status bar and sidebar show every account's 5-hour and weekly usage with reset times. One click switches, and every automatic switch can be undone.
    </td>
    <td width="50%" valign="top">
      <h3>🪟 Many windows, one brain</h3>
      With several VS Code windows open, one monitors usage and switches. If it closes, another takes over.
    </td>
  </tr>
</table>

## Quick start

1. **Install.** Run this in a terminal on macOS or Linux:
   ```sh
   curl -fsSL https://raw.githubusercontent.com/euler1729/ClaudeSwitch/main/install.sh | bash
   ```
   It downloads the latest release, checks it against the published SHA-256 checksum, and installs it into VS Code. **Run the same command again any time to update.** For VS Code Insiders or Cursor, end it with `| CODE=code-insiders bash` or `| CODE=cursor bash`.

   <sub>Prefer to do it by hand? Download `claudeswitch-<version>.vsix` from the [latest release](https://github.com/euler1729/ClaudeSwitch/releases/latest), then in VS Code open the Extensions view, click **⋯** → **Install from VSIX…**, and pick the file.</sub>
2. **Add your accounts.** Open **ClaudeSwitch** in the Activity Bar and click **Add Claude Account**. Sign in on the page that opens in your browser. A small box in VS Code waits and closes by itself when you're done.
3. **Repeat** for each account. That's it. ClaudeSwitch takes it from here.

> **Already signed in to Claude Code?** Click **Add that login** in the empty view, or run **ClaudeSwitch: Add Current Claude Code Login**, to save that account without the browser.

> **Adding a second account while your browser is signed in to claude.ai?** The sign-in page uses whichever account the browser is signed in to. Click the copy button in the waiting box and paste the link into a private window, or sign out of claude.ai first. If you sign in to an account that's already added, ClaudeSwitch says so and renews its saved login.

> **Remote, WSL, Codespaces or browser-based VS Code?** If the browser can't reach VS Code's machine, click the key button in the waiting box. The sign-in page then shows a code to paste into the box. ClaudeSwitch switches to this mode by itself when it can't forward the listener's port.

## How it works

| Step | What happens |
|---|---|
| **1 · Sign in** | The browser returns to a temporary listener on `127.0.0.1`, the same sign-in `claude auth login` uses, with no terminal needed. Each login is saved in VS Code's secret storage, which is your OS keychain. |
| **2 · Watch** | ClaudeSwitch reads the same numbers as Claude Code's `/usage`: the active account every 2 minutes, the others every 15, plus the usage Claude Code caches itself. It also watches session transcripts for messages like "You've hit your session limit" and reacts within seconds. |
| **3 · Switch** | It writes the chosen login into Claude Code's credential store (`~/.claude/.credentials.json`, or the Keychain on macOS) and updates the account shown in `~/.claude.json`. Claude Code reloads its credentials when that store changes. |
| **4 · Stay signed in** | Claude Code rotates the active account's tokens, and ClaudeSwitch saves each new copy. It refreshes inactive accounts' tokens itself so they stay valid. It never refreshes the active account's token, because Claude Code manages that one. |

**Privacy:** ClaudeSwitch only talks to Anthropic's own sign-in and usage endpoints, and to its own sign-in listener on your machine. Tokens never leave your computer otherwise. See [SECURITY.md](SECURITY.md).

## Choosing an account

Each account's weekly allowance resets on its own schedule, and whatever is unused at reset is lost. Switching has a cost too: the prompt cache belongs to one account, so the first request after a switch re-sends the whole conversation without it. The strategies balance the two.

| Strategy | Behavior |
|---|---|
| ⭐ **Efficient** (default) | Uses the account whose weekly limit resets soonest, because its leftover allowance expires first. Stays on an account until it reaches `switchThreshold` (90%). Switches earlier only when another account has at least 25 points of weekly allowance that will expire within 24 hours. |
| ⚖️ **Balanced** | Keeps every account at a similar weekly usage level. Switches when the active account is 20 or more points ahead of the least-used one. |
| 🔢 **Sequential** | Uses accounts in the order listed. Moves to the next when one is exhausted, and back to a higher one once it resets. |
| ✋ **Manual** | Never switches on its own. When the active account is exhausted, it tells you which account to switch to. |

Every strategy follows the same rules:

- An exhausted account is never chosen. An account that's excluded from rotation, or needs you to sign in again, is never chosen automatically.
- An account with less than 10 points of room left is only chosen when nothing else is available.
- Apart from switches forced by an exhausted account, ClaudeSwitch waits at least `minMinutesBetweenSwitches` (30) between switches.
- When every account is exhausted, you're told once when the next one becomes available, and ClaudeSwitch switches to it when its limit resets.

## Using it

- **Status bar:** the active account and its usage. It turns yellow at `warnThreshold` and red when the account is exhausted. Hover for a table of all accounts; click to switch.
- **Accounts view:** each account's usage windows, reset times and any login problems. Right-click to rename, exclude from rotation, reorder or remove.
- **Commands:** `Switch Claude Account…`, `Switch to Best Available Account`, `Refresh Usage`, `Toggle Automatic Switching` and `Show Log`, all under **ClaudeSwitch:** in the Command Palette.
- **After an automatic switch,** a notification names the new account and the reason, with **Undo**.
- **If a saved login stops working** (for example, after you sign out of that account everywhere), the account is marked **Sign in again**. Click it to sign in through the browser.

## Settings

<details>
<summary><b>All settings</b> (search for <code>claudeswitch</code> in VS Code's Settings)</summary>
<br>

| Setting | Default | |
|---|---|---|
| `claudeswitch.autoSwitch` | `true` | Switch automatically. |
| `claudeswitch.strategy` | `efficient` | `efficient`, `balanced`, `sequential` or `manual`. |
| `claudeswitch.switchThreshold` | `90` | Usage percentage at which an account counts as exhausted. |
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

</details>

## Good to know

- **Subscriptions only.** ClaudeSwitch works with Claude Pro, Max, Team and Enterprise logins. It doesn't handle API keys.
- **Unofficial interfaces.** It relies on Claude Code's credential store and usage endpoint, which aren't public APIs, so a future Claude Code release could change them. If switching stops working, check **ClaudeSwitch: Show Log**.
- **macOS login size.** On macOS, a login larger than about 2 KB (for example, one carrying several MCP servers' tokens) can't be written to the Keychain this way. ClaudeSwitch then refuses that switch and leaves your current login untouched.
- **`/status` may lag.** If a running Claude Code process rewrites `~/.claude.json` at the moment of a switch, `/status` can briefly show the previous email. Requests still use the new account.
- **claude.ai counts too.** Usage on claude.ai counts toward the same limits; ClaudeSwitch notices it at its next check of that account.
- **Play fair.** Each account is subject to its own plan's terms. Only add accounts you're entitled to use.

## Development

```sh
npm install
npm test          # compiles, then runs unit and integration tests (Node's built-in runner)
npm run watch     # recompile on change; press F5 in VS Code to launch an Extension Development Host
npm run package   # builds claudeswitch-<version>.vsix
```

The integration test runs the real controller against a temporary Claude config folder and a fake API server, including the browser sign-in with a simulated browser visiting the callback. It never touches your `~/.claude`; on macOS it uses a throwaway Keychain item instead of your real login. CI runs the tests on both Linux and macOS.

<details>
<summary><b>Releasing</b></summary>
<br>

1. Update `version` in `package.json`, and add a matching `## <version>` section at the top of `CHANGELOG.md`.
2. Commit, then tag and push: `git tag v<version> && git push origin main v<version>`.

The Release workflow runs the tests, builds the `.vsix`, and publishes a GitHub release. The notes come from that version's CHANGELOG section, and the release includes install steps and SHA-256 checksums.

</details>

<details>
<summary><b>Code map</b></summary>
<br>

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

</details>
