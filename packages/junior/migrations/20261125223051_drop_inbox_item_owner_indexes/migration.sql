-- `junior_inbox_items_open_subject_key_uidx` now keeps one open item per
-- subject. Reads find the items of an owner through the subject, so the
-- indexes on `owner_id` and on the provider tenant have no reader.
DROP INDEX IF EXISTS "junior_inbox_items_open_subject_uidx";--> statement-breakpoint
DROP INDEX IF EXISTS "junior_inbox_items_owner_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "junior_inbox_items_open_action_owner_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "junior_inbox_items_answered_idx";
