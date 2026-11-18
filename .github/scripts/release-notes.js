// Prints the GitHub release notes for a version: its CHANGELOG.md section plus install steps.
// Usage: node .github/scripts/release-notes.js 0.2.1
const fs = require('fs');
const path = require('path');

const version = process.argv[2];
if (!version) {
  console.error('usage: release-notes.js <version>');
  process.exit(1);
}

const lines = fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8').split('\n');
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const heading = new RegExp(`^## \\[?${escaped}\\]?(\\s|$)`);
const start = lines.findIndex((l) => heading.test(l));
if (start < 0) {
  console.error(`CHANGELOG.md has no "## ${version}" section.`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
if (end < 0) {
  end = lines.length;
}
const body = lines.slice(start + 1, end).join('\n').trim();
const file = `claudeswitch-${version}.vsix`;

process.stdout.write(`${body}

### Install

1. Download **${file}** from the assets below.
2. In VS Code, open the Extensions view, click **⋯**, choose **Install from VSIX…**, and pick the file. Or run \`code --install-extension ${file}\`.
3. Reload the window, open **ClaudeSwitch** in the Activity Bar, and add your accounts.

**Requires** VS Code 1.90 or later, and Claude Code signed in with a Claude Pro, Max, Team or Enterprise plan.

To check the download, run \`sha256sum -c SHA256SUMS.txt\` in the folder that holds both files.
`);
