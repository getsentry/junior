-- Repeat the awaiting_resume rename of 0089_conversation_paused_status.
-- Workers before 0.288.0 still wrote awaiting_resume after 0089 ran, and
-- readers no longer accept that name.
-- junior:bounded-backfill: changes only Conversations that an old worker paused and that did not resume, so few rows match.
UPDATE "junior_conversations" SET "execution_status" = 'paused' WHERE "execution_status" = 'awaiting_resume';--> statement-breakpoint
-- 0057_drop_legacy_automation_tables removed these from the snapshot and kept
-- them in the database for one release.
DROP INDEX IF EXISTS "junior_conversations_origin_idx";--> statement-breakpoint
ALTER TABLE "junior_conversations" DROP COLUMN IF EXISTS "origin_type";--> statement-breakpoint
ALTER TABLE "junior_conversations" DROP COLUMN IF EXISTS "origin_id";--> statement-breakpoint
ALTER TABLE "junior_conversations" DROP COLUMN IF EXISTS "origin_run_id";--> statement-breakpoint
ALTER TABLE "junior_automation_versions" DROP COLUMN IF EXISTS "kind";
