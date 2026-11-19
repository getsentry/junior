CREATE TABLE "junior_conversation_brief_totals" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"stored" bigint NOT NULL,
	"conversations" bigint NOT NULL,
	CONSTRAINT "junior_conversation_brief_totals_one_row" CHECK ("junior_conversation_brief_totals"."id")
);
--> statement-breakpoint
-- Keep the one totals row exact for every insert and delete of a Brief,
-- including a purge and a cascade from junior_conversations. The trigger is
-- deferred to commit, so the totals row lock comes last in each transaction
-- and is held only while it commits.
CREATE FUNCTION "junior_conversation_brief_totals_apply"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
	IF TG_OP = 'INSERT' THEN
		INSERT INTO "junior_conversation_brief_totals" AS totals ("id", "stored", "conversations")
		VALUES (true, 1, CASE WHEN NEW."version" = 1 THEN 1 ELSE 0 END)
		ON CONFLICT ("id") DO UPDATE SET
			"stored" = totals."stored" + 1,
			"conversations" = totals."conversations" + excluded."conversations";
	ELSE
		UPDATE "junior_conversation_brief_totals" SET
			"stored" = "stored" - 1,
			"conversations" = "conversations" - CASE WHEN OLD."version" = 1 THEN 1 ELSE 0 END;
	END IF;
	RETURN NULL;
END;
$function$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "junior_conversation_brief_totals_apply"
AFTER INSERT OR DELETE ON "junior_conversation_briefs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "junior_conversation_brief_totals_apply"();--> statement-breakpoint
-- The trigger's table lock blocks Brief writes until this commits, so no
-- Brief is counted twice or missed.
INSERT INTO "junior_conversation_brief_totals" ("id", "stored", "conversations")
SELECT true, count(*), count(*) FILTER (WHERE "version" = 1)
FROM "junior_conversation_briefs";
