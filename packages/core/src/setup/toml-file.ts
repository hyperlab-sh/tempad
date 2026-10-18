import { defaultIntentConfig } from "../intent/config.ts";
import { usageText } from "../usage.ts";

/**
 * A minimal `tempad.toml`: everything commented out, so a fresh home behaves exactly
 * like an absent file. The `[w5]` block shows the current defaults (read from
 * `defaultIntentConfig`, so it cannot drift); the project rule is a generic placeholder.
 */
export function renderTomlFile(): string {
  const w5 = defaultIntentConfig().w5;
  return `# tempad.toml, written by \`tempad setup\`. Everything here is optional and commented out.
# Documentation: docs/specs/ in the tempad repository.

# Classifier settings for the w5 hook. Values shown are the defaults.
# [w5]
# "claude-cli" rides your Claude subscription; "api" needs ANTHROPIC_API_KEY.
# backend = "${w5.backend}"
# claude_command = "${w5.claudeCommand}"
# model = "${w5.model}"
# mode = "${w5.mode}"
# inference_fallback = ${w5.inferenceFallback}
# timeout_seconds = ${w5.timeoutSeconds}
# throttle_minutes = ${w5.throttleMinutes}
# stint_idle_minutes = ${w5.stintIdleMinutes}
# stint_min_minutes = ${w5.stintMinMinutes}
# memory_hours = ${w5.memoryHours}
# memory_stints = ${w5.memoryStints}
# memory_quests = ${w5.memoryQuests}
# overlap_messages = ${w5.overlapMessages}
# backfill_days = ${w5.backfillDays}

# Project rules map a working directory to an org/project and a display name.
# A \`path\` rule matches one exact folder and everything under it; list path rules
# before pattern rules, since the first match wins. Or run:
#   ${usageText("project register")}

# [[projects]]
# path = "~/work/my-project"
# name = "My Project"
# org = "my-org"
# project = "my-project"

# [[projects]]
# pattern = "~/work/:org/:project/:rest*"
`;
}
