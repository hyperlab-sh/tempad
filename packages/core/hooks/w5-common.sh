#!/usr/bin/env bash
# Shared by w5-stop.sh and w5-prompt.sh (sourced, never run on its own).
#
# Contract: a hook must never disturb a session. Every early exit is `exit 0`
# with nothing on stdout or stderr, and diagnostics go to TEMPAD_HOME/logs/w5.log
# only once the home exists (an unconfigured machine gets no ~/.tempad).

# TEMPAD_HOME with a leading `~` or `~/` expanded, exactly as tempadHome() does in
# src/config/env.ts (Claude settings `env` values reach us unexpanded).
case "${TEMPAD_HOME:-}" in
  "") TEMPAD_HOME_DIR="$HOME/.tempad" ;;
  "~") TEMPAD_HOME_DIR="$HOME" ;;
  "~/"*) TEMPAD_HOME_DIR="$HOME/${TEMPAD_HOME#"~/"}" ;;
  *) TEMPAD_HOME_DIR="$TEMPAD_HOME" ;;
esac
W5_LOG_FILE="$TEMPAD_HOME_DIR/logs/w5.log"

# Extract the session id from the hook payload on stdin; sets $session_id.
w5_read_payload() {
  payload="$(cat)"
  session_id="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  hook_event_name="$(printf '%s' "$payload" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
}

# Configured means TEMPAD_HOME/.env or TEMPAD_HOME/tempad.db exists.
w5_is_configured() {
  [ -f "$TEMPAD_HOME_DIR/.env" ] || [ -f "$TEMPAD_HOME_DIR/tempad.db" ]
}

# Append one line to w5.log. Only call once w5_is_configured has passed: this
# creates the logs/ directory, and the home must already exist by then.
w5_log() {
  mkdir -p "$TEMPAD_HOME_DIR/logs" 2>/dev/null || return 0
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) $1" >> "$W5_LOG_FILE" 2>/dev/null || true
}

# A legacy settings.json hook (marked "tempad": true by `tempad w5 hook install`)
# is still installed in the user settings or the project settings. User settings
# are $CLAUDE_CONFIG_DIR/settings.json when that is non-empty, else
# $HOME/.claude/settings.json, never both (Claude Code reads only one, and
# `tempad w5 hook uninstall` edits only that one: userClaudeDirectory() in
# src/w5/hooks.ts).
w5_legacy_hook_installed() {
  local settings user_settings
  if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
    user_settings="$CLAUDE_CONFIG_DIR/settings.json"
  else
    user_settings="$HOME/.claude/settings.json"
  fi
  for settings in \
    "$user_settings" \
    "${CLAUDE_PROJECT_DIR:+$CLAUDE_PROJECT_DIR/.claude/settings.json}"; do
    [ -n "$settings" ] && [ -f "$settings" ] || continue
    if grep -Eq '"tempad"[[:space:]]*:[[:space:]]*true' "$settings" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

# Common gate for both scripts. $1 = script name. Exits 0 for every case where
# the hook should do nothing; otherwise sets the `_bin` array to the CLI argv.
w5_gate() {
  local script="$1"

  case "$session_id" in
    "" ) exit 0 ;;
    *[!A-Za-z0-9_-]* )
      if w5_is_configured; then
        w5_log "$script: rejecting session id with unexpected characters"
      fi
      exit 0
      ;;
  esac

  w5_is_configured || exit 0

  # Home exists now, so the log directory may be created. If it cannot be,
  # send CLI stderr to /dev/null rather than let a failed redirect skip the call.
  mkdir -p "$TEMPAD_HOME_DIR/logs" 2>/dev/null || true
  if [ ! -d "$TEMPAD_HOME_DIR/logs" ] || [ ! -w "$TEMPAD_HOME_DIR/logs" ]; then
    W5_LOG_FILE=/dev/null
  fi

  # Plugin hooks stand down while legacy settings hooks exist. Legacy hooks
  # (no TEMPAD_HOOK_SOURCE) never stand down.
  if [ "${TEMPAD_HOOK_SOURCE:-}" = "plugin" ] && w5_legacy_hook_installed; then
    exit 0
  fi

  if [ -n "${TEMPAD_BIN:-}" ]; then
    # shellcheck disable=SC2206
    _bin=($TEMPAD_BIN)
  elif command -v tempad >/dev/null 2>&1; then
    _bin=(tempad)
  elif command -v bun >/dev/null 2>&1; then
    _bin=(bun x @hyperlab.sh/tempad)
  else
    w5_log "$script: no tempad CLI found (TEMPAD_BIN unset, no tempad or bun on PATH), skipping session $session_id"
    exit 0
  fi
}
