# Changelog

## 0.2.4 — 2026-11-18

### Changed

- ClaudeSwitch is now published by **CSAI**, so its extension ID changes from `claudeswitch.claudeswitch` to `CSAI.claudeswitch`. VS Code treats this as a new extension, so **accounts saved in earlier versions don't carry over**: after updating, add them again from the ClaudeSwitch view. It offers to add the login Claude Code is currently using.
- The install command removes the old `claudeswitch.claudeswitch` copy for you. If you installed by hand, uninstall the old ClaudeSwitch from the Extensions view so the two copies don't clash.

## 0.2.3 — 2026-11-18

### Changed

- ClaudeSwitch now switches away from an account at 90% of its 5-hour or weekly limit, instead of 95%. Usage is checked every 2 minutes, so the extra margin means the switch usually happens before Claude Code hits the limit. If you've set `claudeswitch.switchThreshold` yourself, your value is kept.

### Added

- A one-line command to install or update ClaudeSwitch from a terminal on macOS or Linux: `curl -fsSL https://raw.githubusercontent.com/euler1729/ClaudeSwitch/main/install.sh | bash`. It checks the download against the release's SHA-256 checksum.

## 0.2.2 — 2026-11-18

### Security

- On macOS, credentials are written to the Keychain through standard input instead of command-line arguments, so other local users can't see them in the process list.
- Build tooling updated to clear the known vulnerabilities that have fixes (`@vscode/vsce` 4, `minimatch` 11). The extension itself has no runtime dependencies.
- Added a security policy, CodeQL scanning and Dependabot updates. Workflows now run with least-privilege permissions and pinned action versions.

### Fixed

- On macOS, switching to an account whose saved login is larger than about 2 KB (for example, one carrying several MCP servers' tokens) no longer corrupts Claude Code's Keychain entry. ClaudeSwitch now refuses that switch and leaves the current login unchanged.
- The tests now also run on macOS in CI, against a throwaway Keychain.

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
