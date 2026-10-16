-- A side quest can deviate from a quest rather than from one of its stints:
-- `tempad quest declare --new Y --deviates-from X` names a quest, and that
-- quest may have no stint yet. `deviates_from_quest_id` holds that quest id
-- on the side quest's own row, next to `deviates_from_stint_id`, which keeps
-- naming a stint only. The `quests` projection fills both from
-- `quest.branched` events, including the inverted ones `declare` wrote before
-- this change (see the `quest.branched` case in
-- src/intent/projections/quest.ts). Run `tempad rebuild` once to re-project
-- existing rows.
ALTER TABLE quests ADD COLUMN deviates_from_quest_id TEXT;
