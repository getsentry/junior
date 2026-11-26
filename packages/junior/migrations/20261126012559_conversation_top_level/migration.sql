-- A Space's Conversations become children of its Lead, so the tree root of
-- each one is the Lead. The new column keeps the top-level Conversation of
-- each piece of work, which Participants, pins, and lists key on. A writer
-- of the previous deploy sets only the root, so this trigger fills the new
-- column from the parent when a write sets the root without it. A first
-- contact row sets neither until its first full write. The next migration
-- fills the stored rows.
ALTER TABLE "junior_conversations" ADD COLUMN "top_level_conversation_id" text;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "junior_conversations_fill_top_level"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
	IF NEW."parent_conversation_id" IS NULL THEN
		NEW."top_level_conversation_id" := NEW."conversation_id";
	ELSE
		NEW."top_level_conversation_id" := (
			SELECT CASE
				WHEN "parent"."kind" = 'lead' THEN NEW."conversation_id"
				ELSE coalesce("parent"."top_level_conversation_id", "parent"."root_conversation_id")
			END
			FROM "junior_conversations" "parent"
			WHERE "parent"."conversation_id" = NEW."parent_conversation_id"
		);
	END IF;
	RETURN NEW;
END
$function$;--> statement-breakpoint
CREATE TRIGGER "junior_conversations_fill_top_level" BEFORE INSERT OR UPDATE ON "junior_conversations" FOR EACH ROW WHEN (NEW."top_level_conversation_id" IS NULL AND NEW."root_conversation_id" IS NOT NULL) EXECUTE FUNCTION "junior_conversations_fill_top_level"();
