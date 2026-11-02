#!/usr/bin/env bash
set -u

# shellcheck source=w5-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/w5-common.sh"

w5_read_payload
w5_gate "w5-stop.sh" no-cli

# Claude Code cancels a slow endSession hook, and starting bun is slow. So this
# only appends the request to the spool; the next `tempad w5 run` (started by
# the next prompt's `w5 context`, or by `tempad sync`) turns it into a job.
case "$hook_event_name" in
  Stop) w5_spool_enqueue classify 0 ;;
  SessionEnd) w5_spool_enqueue session_end 1 ;;
  *) w5_spool_enqueue classify 1 ;;
esac

exit 0
