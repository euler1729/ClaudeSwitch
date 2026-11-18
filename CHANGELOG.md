# Changelog

## 0.2.2 — 2026-11-18

### Security

- On macOS, credentials are written to the Keychain through standard input instead of command-line arguments, so other local users can't see them in the process list.
- Build tooling updated to clear the known vulnerabilities that have fixes (`@vscode/vsce` 4, `minimatch` 11). The extension itself has no runtime dependencies.
- Added a security policy, CodeQL scanning and Dependabot updates. Workflows now run with least-privilege permissions and pinned action versions.

## 0.2.1 — 2026-11-18

First release. ClaudeSwitch moves Claude Code to another of your Claude accounts when the active one reaches its usage limit.

### Features

- **Automatic switching** when the active account reaches its 5-hour or weekly limit (95% by default). A limit error in a Claude Code session triggers the switch within seconds, and running sessions use the new account from their next request.
- **Efficient account choice:** ClaudeSwitch uses the account whose weekly limit resets soonest, so that account's unused allowance isn't lost at reset. Balanced, Sequential and Manual strategies are also available.
- **Browser sign-in** for adding accounts. Adding an account doesn't change the account Claude Code is using.
- **Usage at a glance:** the status bar shows 5-hour and weekly usage. The sidebar lists every account with its reset times. Switching takes one click and can be undone.
- **Several VS Code windows:** one window monitors usage and switches, and another takes over if it closes.
- New logo in Claude's orange.

### Known limitations

- ClaudeSwitch depends on Claude Code's internal credential files and usage endpoint, which can change between Claude Code releases.
- Tested on Linux only. macOS Keychain support is untested.
- ClaudeSwitch is unofficial and not affiliated with Anthropic.
