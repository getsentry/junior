-- Drop the junior_space_members table that space_lead_holds_name kept in
-- the database. No runtime code reads or writes it since 0.317.0.
-- The snapshot no longer has junior_spaces.name, visibility, or
-- archived_at, but they stay in the database for one release. 0.319.0 does
-- not read them, but its Space insert lists every column of its schema, so
-- it writes their defaults while this migration runs. The release that drops
-- them uses DROP COLUMN IF EXISTS.
-- squawk-ignore ban-drop-table -- unused since 0.317.0
DROP TABLE IF EXISTS "junior_space_members";
