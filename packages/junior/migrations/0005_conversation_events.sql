ALTER TABLE "junior_agent_steps" RENAME TO "junior_conversation_events";--> statement-breakpoint
ALTER TABLE "junior_conversation_events" RENAME CONSTRAINT "junior_agent_steps_conversation_id_seq_pk" TO "junior_conversation_events_conversation_id_seq_pk";--> statement-breakpoint
ALTER TABLE "junior_conversation_events" RENAME CONSTRAINT "junior_agent_steps_conversation_id_junior_conversations_conversation_id_fk" TO "junior_conversation_events_conversation_id_junior_conversations_conversation_id_fk";--> statement-breakpoint
ALTER INDEX "junior_agent_steps_epoch_idx" RENAME TO "junior_conversation_events_epoch_idx";--> statement-breakpoint
ALTER TABLE "junior_conversation_events" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Temporary 0.103.x compatibility; 0005 removes the view and functions after
-- the required worker drain.
CREATE VIEW "junior_agent_steps" AS
SELECT
	"conversation_id",
	"seq",
	"context_epoch",
	CASE WHEN "type" = 'message' THEN 'pi_message' ELSE "type" END AS "type",
	"role",
	"payload",
	"created_at"
FROM "junior_conversation_events";--> statement-breakpoint
CREATE FUNCTION "junior_agent_steps_insert_compat"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	INSERT INTO "junior_conversation_events" (
		"conversation_id",
		"seq",
		"context_epoch",
		"schema_version",
		"type",
		"role",
		"payload",
		"created_at"
	) VALUES (
		NEW."conversation_id",
		NEW."seq",
		NEW."context_epoch",
		1,
		CASE WHEN NEW."type" = 'pi_message' THEN 'message' ELSE NEW."type" END,
		NEW."role",
		CASE
			WHEN NEW."type" = 'pi_message'
				AND jsonb_typeof(NEW."payload") = 'object'
			THEN NEW."payload" - 'schemaVersion'
			ELSE NEW."payload"
		END,
		NEW."created_at"
	);
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "junior_agent_steps_insert_compat_trigger"
INSTEAD OF INSERT ON "junior_agent_steps"
FOR EACH ROW EXECUTE FUNCTION "junior_agent_steps_insert_compat"();--> statement-breakpoint
CREATE FUNCTION "junior_agent_steps_delete_compat"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	DELETE FROM "junior_conversation_events"
	WHERE "conversation_id" = OLD."conversation_id"
		AND "seq" = OLD."seq";
	RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "junior_agent_steps_delete_compat_trigger"
INSTEAD OF DELETE ON "junior_agent_steps"
FOR EACH ROW EXECUTE FUNCTION "junior_agent_steps_delete_compat"();
