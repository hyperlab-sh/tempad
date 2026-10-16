#!/usr/bin/env bash
set -u

# shellcheck source=w5-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/w5-common.sh"

w5_read_payload
w5_gate "w5-prompt.sh"

context="$("${_bin[@]}" w5 context --session "$session_id" 2>>"$W5_LOG_FILE" || true)"

if [ -n "$context" ]; then
  # JSON-escape by hand: drop control characters JSON forbids raw (CR and the rest
  # of 0x01-0x1f except tab and newline), then escape \, " and tab; awk joins lines with \n.
  tab="$(printf '\t')"
  context_json=$(printf '%s' "$context" | tr -d '\000-\010\013\014\015\016-\037' | sed "s/\\\\/\\\\\\\\/g; s/\"/\\\\\"/g; s/$tab/\\\\t/g" | awk '{printf "%s\\n", $0}')
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$context_json"
fi

exit 0
