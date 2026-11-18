-- NOT VALID: the widened checks accept every existing row, so they skip the
-- scan and still hold for every new write.
ALTER TABLE "junior_conversations" DROP CONSTRAINT "junior_conversations_kind_check";--> statement-breakpoint
ALTER TABLE "junior_conversations" DROP CONSTRAINT "junior_conversations_kind_parent_check";--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_kind_check" CHECK ("junior_conversations"."kind" in ('root', 'automation', 'thread', 'task')) NOT VALID;--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_kind_parent_check" CHECK ("junior_conversations"."kind" is null or (("junior_conversations"."kind" in ('root', 'automation')) = ("junior_conversations"."parent_conversation_id" is null))) NOT VALID;