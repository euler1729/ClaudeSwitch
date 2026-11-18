#!/usr/bin/env bash
# Installs the latest ClaudeSwitch release into VS Code. Run it again at any time to update.
#
#   curl -fsSL https://raw.githubusercontent.com/euler1729/ClaudeSwitch/main/install.sh | bash
#
# Set CODE to use a different editor command, for example CODE=code-insiders or CODE=cursor.

set -euo pipefail

REPO="euler1729/ClaudeSwitch"
EXTENSION_ID="claudeswitch.claudeswitch"
DOWNLOAD="https://github.com/${REPO}/releases/latest/download"

fail() {
  printf 'ClaudeSwitch: %s\n' "$*" >&2
  exit 1
}

# VS Code's command-line tool. macOS doesn't put it on PATH by default, so look inside the app too.
find_code() {
  if [ -n "${CODE:-}" ]; then
    command -v "$CODE" || fail "CODE is set to '$CODE', but that command wasn't found."
    return
  fi
  local candidate app
  for candidate in code code-insiders; do
    if command -v "$candidate" 2>/dev/null; then
      return
    fi
  done
  for app in "/Applications/Visual Studio Code.app" "$HOME/Applications/Visual Studio Code.app" \
    "/Applications/Visual Studio Code - Insiders.app" "$HOME/Applications/Visual Studio Code - Insiders.app"; do
    for candidate in "$app/Contents/Resources/app/bin/code" "$app/Contents/Resources/app/bin/code-insiders"; do
      if [ -x "$candidate" ]; then
        printf '%s\n' "$candidate"
        return
      fi
    done
  done
  fail "couldn't find VS Code's 'code' command. In VS Code, run 'Shell Command: Install 'code' command in PATH' from the Command Palette, then try again."
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

main() {
  command -v curl >/dev/null 2>&1 || fail "curl is required."
  local code
  code="$(find_code)"

  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064 # expand $tmp now, while it's set
  trap "rm -rf '$tmp'" EXIT

  # The checksum file has a fixed name in every release and names the current .vsix.
  curl -fsSL "${DOWNLOAD}/SHA256SUMS.txt" -o "$tmp/SHA256SUMS.txt" || fail "couldn't reach the latest release on GitHub."
  local expected file
  read -r expected file < <(grep -E '^[0-9a-f]{64}  claudeswitch-[0-9]+\.[0-9]+\.[0-9]+\.vsix$' "$tmp/SHA256SUMS.txt" | head -n 1) ||
    fail "the latest release doesn't list a .vsix file."
  local version="${file#claudeswitch-}"
  version="${version%.vsix}"

  local installed
  installed="$("$code" --list-extensions --show-versions 2>/dev/null | grep -i "^${EXTENSION_ID}@" | cut -d@ -f2 || true)"

  printf 'Downloading ClaudeSwitch %s…\n' "$version"
  curl -fsSL "${DOWNLOAD}/${file}" -o "$tmp/$file" || fail "couldn't download $file."
  [ "$(sha256 "$tmp/$file")" = "$expected" ] || fail "the download of $file doesn't match its published checksum. Nothing was installed."

  # Always install the published build, even over the same version number: a copy built locally
  # can carry the same version with different code.
  if ! "$code" --install-extension "$tmp/$file" --force >"$tmp/install.log" 2>&1; then
    cat "$tmp/install.log" >&2
    fail "VS Code couldn't install $file."
  fi
  if [ -z "$installed" ]; then
    printf 'Installed ClaudeSwitch %s.\n' "$version"
  elif [ "$installed" = "$version" ]; then
    printf 'Reinstalled ClaudeSwitch %s, the latest version.\n' "$version"
  else
    printf 'Updated ClaudeSwitch from %s to %s.\n' "$installed" "$version"
  fi
  printf 'Reload open VS Code windows (Developer: Reload Window), then open ClaudeSwitch in the Activity Bar.\n'
}

main "$@"
