# Security policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Report vulnerabilities privately: open this repository's **Security** tab and click **Report a vulnerability**. Please don't open a public issue.

Include the affected version, steps to reproduce, and what an attacker could do. You can expect a first reply within 7 days.

## What ClaudeSwitch handles

ClaudeSwitch manages Claude sign-in tokens, so these areas matter most:

- **Tokens** are kept in VS Code's secret storage, which is your OS keychain, and in Claude Code's own credential store. They are never written to logs or to ClaudeSwitch's own files.
- **Account list and usage numbers** (emails, percentages, reset times, no tokens) are kept in a `state.json` file in VS Code's extension storage, readable only by your user.
- **Browser sign-in** uses a one-time listener on `127.0.0.1` that only accepts a callback carrying that sign-in's random `state` value. It closes when sign-in finishes.
- **Network calls** go only to Anthropic's endpoints (`api.anthropic.com`, `platform.claude.com`).

Reports of a token leaking (to logs, files, other users or processes, or the network) are especially welcome.
