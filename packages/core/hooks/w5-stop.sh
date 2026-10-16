#!/usr/bin/env bash
set -u

# shellcheck source=w5-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/w5-common.sh"

w5_read_payload
w5_gate "w5-stop.sh"

case "$hook_event_name" in
  Stop) kind="classify" ;;
  SessionEnd) kind="session_end" ;;
  *) kind="classify" ;;
esac

if [ "$hook_event_name" != "Stop" ]; then
  "${_bin[@]}" w5 enqueue --session "$session_id" --forced --kind "$kind" >/dev/null 2>>"$W5_LOG_FILE" || true
else
  "${_bin[@]}" w5 enqueue --session "$session_id" --kind "$kind" >/dev/null 2>>"$W5_LOG_FILE" || true
fi

exit 0
