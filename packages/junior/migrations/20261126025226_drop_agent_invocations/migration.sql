-- Drop the junior_agent_invocations table that 0160_agent_config_backfill
-- kept in the database. No runtime code reads or writes it since 0.314.0.
-- Retention purge in 0.316.0 still deletes its rows, so a purge that runs on
-- that release during the deploy fails, and the next run retries the tree.
-- squawk-ignore ban-drop-table -- unused since 0.314.0
DROP TABLE IF EXISTS "junior_agent_invocations";
