-- NOT VALID: the widened check accepts every existing row, so it skips the
-- scan and still holds for every new write.
ALTER TABLE "junior_conversations" DROP CONSTRAINT "junior_conversations_kind_parent_check";--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_kind_parent_check" CHECK ("junior_conversations"."kind" is null or "junior_conversations"."kind" = 'root' or (("junior_conversations"."kind" in ('automation', 'lead')) = ("junior_conversations"."parent_conversation_id" is null))) NOT VALID;
