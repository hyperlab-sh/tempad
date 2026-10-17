-- Count how many times a w5 job has been claimed, so a job whose runner died
-- (left in state running with a stale claimed_at) can be requeued a bounded
-- number of times before it is failed. A job claimed before this migration
-- counts 0, so it gets one attempt more than the others, which is harmless.
ALTER TABLE w5_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
