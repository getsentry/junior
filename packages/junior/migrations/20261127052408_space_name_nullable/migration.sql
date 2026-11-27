-- New Spaces keep their name on the Lead only. 0.317.0 and 0.318.0 do not
-- read junior_spaces.name. A rollback to 0.316.0, which reads it, is no
-- longer supported.
-- squawk-ignore ban-drop-not-null -- unused since 0.317.0
ALTER TABLE "junior_spaces" ALTER COLUMN "name" DROP NOT NULL;
