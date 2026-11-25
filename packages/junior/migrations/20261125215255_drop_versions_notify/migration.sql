-- Drop the NOTIFY triggers that 20261125124506_versions_notify added. The
-- dashboard versions stream that listened for them is gone.
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
