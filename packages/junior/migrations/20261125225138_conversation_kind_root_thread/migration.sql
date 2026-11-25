-- The `root` kind is now `thread`, and a `thread` may have a parent. A
-- writer of the previous deploy still writes `root`, so this trigger stores
-- it as `thread`, and both checks accept both values until every writer
-- stores `thread`. NOT VALID skips the scan under lock, and every new write
-- is checked. The next migration moves the stored `root` rows to `thread`.
ALTER TABLE "junior_conversations" DROP CONSTRAINT "junior_conversations_kind_check";--> statement-breakpoint
ALTER TABLE "junior_conversations" DROP CONSTRAINT "junior_conversations_kind_parent_check";--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_kind_check" CHECK ("kind" in ('root', 'thread', 'automation', 'lead', 'task')) NOT VALID;--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_kind_parent_check" CHECK ("kind" is null or "kind" in ('root', 'thread') or (("kind" in ('automation', 'lead')) = ("parent_conversation_id" is null))) NOT VALID;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "junior_conversations_kind_root_to_thread"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
	NEW."kind" := 'thread';
	RETURN NEW;
END
$function$;--> statement-breakpoint
CREATE TRIGGER "junior_conversations_kind_root_to_thread" BEFORE INSERT OR UPDATE ON "junior_conversations" FOR EACH ROW WHEN (NEW."kind" = 'root') EXECUTE FUNCTION "junior_conversations_kind_root_to_thread"();
