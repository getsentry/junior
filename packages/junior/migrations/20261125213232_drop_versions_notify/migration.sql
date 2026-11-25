-- Drop the `junior_notify_versions` triggers and function from
-- 20261125124506_versions_notify. Only the dashboard versions stream listened
-- to them, and only release 0.315.0 shipped it. The release after 0.315.0
-- removes the stream. Code in 0.315.0 still works without them: an open
-- stream gets no change, and the client reads fresh tokens when the stream
-- reconnects or the poll runs.
DROP TRIGGER IF EXISTS "junior_notify_versions" ON "junior_conversations";--> statement-breakpoint
DROP TRIGGER IF EXISTS "junior_notify_versions" ON "junior_conversation_participants";--> statement-breakpoint
DROP TRIGGER IF EXISTS "junior_notify_versions" ON "junior_conversation_annotations";--> statement-breakpoint
DROP TRIGGER IF EXISTS "junior_notify_versions" ON "junior_inbox_items";--> statement-breakpoint
DROP TRIGGER IF EXISTS "junior_notify_versions" ON "junior_conversation_metrics";--> statement-breakpoint
DROP TRIGGER IF EXISTS "junior_notify_versions" ON "junior_attachments";--> statement-breakpoint
DROP TRIGGER IF EXISTS "junior_notify_versions" ON "junior_identities";--> statement-breakpoint
DROP TRIGGER IF EXISTS "junior_notify_versions" ON "junior_users";--> statement-breakpoint
DROP TRIGGER IF EXISTS "junior_notify_versions" ON "junior_destinations";--> statement-breakpoint
DROP TRIGGER IF EXISTS "junior_notify_versions" ON "junior_inbox_snoozes";--> statement-breakpoint
DROP TRIGGER IF EXISTS "junior_notify_versions" ON "junior_conversation_events";--> statement-breakpoint
DROP FUNCTION IF EXISTS "junior_notify_versions"();
