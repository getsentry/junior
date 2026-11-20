-- A Review item now names its owner: a Conversation, as before, or an
-- Automation for an Automation alert. Every existing item belongs to the
-- Conversation that added it, so the old column becomes the owner id, and
-- the default of the new kind column fills existing rows with
-- 'conversation'. A constant default writes no row. The owner id has no
-- foreign key, because it can name more than one table. Conversations are
-- never deleted, so no cascade is lost. An older runtime cannot write
-- Review items once this runs, until the new runtime serves.
ALTER TABLE "junior_review_items" RENAME COLUMN "added_by_conversation_id" TO "owner_id";--> statement-breakpoint
ALTER TABLE "junior_review_items" DROP CONSTRAINT "junior_review_items_added_by_conversation_id_junior_conversations_conversation_id_fk";--> statement-breakpoint
ALTER TABLE "junior_review_items" ADD COLUMN "owner_kind" text DEFAULT 'conversation' NOT NULL;--> statement-breakpoint
-- The index keeps its definition on the renamed column.
ALTER INDEX "junior_review_items_open_action_added_by_idx" RENAME TO "junior_review_items_open_action_owner_idx";--> statement-breakpoint
ALTER TABLE "junior_review_items" DROP CONSTRAINT "junior_review_items_kind_check";--> statement-breakpoint
-- Both checks hold for every existing row: each is a Conversation item, and
-- agents and plugins use no `automation:` key. NOT VALID skips the scan
-- under lock and still checks every new write.
ALTER TABLE "junior_review_items" ADD CONSTRAINT "junior_review_items_owner_check" CHECK (("junior_review_items"."owner_kind" = 'conversation' and "junior_review_items"."dedupe_key" not like 'automation:%') or ("junior_review_items"."owner_kind" = 'automation' and "junior_review_items"."dedupe_key" like 'automation:%')) NOT VALID;--> statement-breakpoint
ALTER TABLE "junior_review_items" ADD CONSTRAINT "junior_review_items_kind_check" CHECK (("junior_review_items"."kind" = 'notice' and "junior_review_items"."request" is null and "junior_review_items"."answer" is null) or ("junior_review_items"."kind" = 'action' and ("junior_review_items"."request" is not null or (("junior_review_items"."dedupe_key" like 'plugin:%' or "junior_review_items"."dedupe_key" like 'automation:%') and "junior_review_items"."answer" is null)))) NOT VALID;
