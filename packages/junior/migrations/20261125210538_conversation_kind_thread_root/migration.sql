-- A Thread is now a `root` with a parent, so `root` may have a parent and
-- `thread` is no longer a kind. NOT VALID skips the scan under lock. The
-- next migration moves the stored `thread` rows to `root`, and every new
-- write is checked.
ALTER TABLE "junior_conversations" DROP CONSTRAINT "junior_conversations_kind_check";--> statement-breakpoint
ALTER TABLE "junior_conversations" DROP CONSTRAINT "junior_conversations_kind_parent_check";--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_kind_check" CHECK ("kind" in ('root', 'automation', 'lead', 'task')) NOT VALID;--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_kind_parent_check" CHECK ("kind" is null or "kind" = 'root' or (("kind" in ('automation', 'lead')) = ("parent_conversation_id" is null))) NOT VALID;
