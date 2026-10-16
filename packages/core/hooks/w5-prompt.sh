#!/usr/bin/env bash
set -u

# shellcheck source=w5-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/w5-common.sh"

w5_read_payload
w5_gate "w5-prompt.sh"

context="$("${_bin[@]}" w5 context --session "$session_id" 2>>"$W5_LOG_FILE" || true)"

if [ -n "$context" ]; then
  context_json=$(printf '%s' "$context" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{printf "%s\\n", $0}')
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$context_json"
fi

exit 0
