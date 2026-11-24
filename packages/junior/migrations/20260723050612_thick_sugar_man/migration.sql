ALTER TABLE "junior_conversations" ADD COLUMN "root_conversation_id" text;--> statement-breakpoint
WITH RECURSIVE "conversation_roots" AS (
	SELECT
		"conversation_id",
		"conversation_id" AS "root_conversation_id"
	FROM "junior_conversations"
	WHERE "parent_conversation_id" IS NULL

	UNION ALL

	SELECT
		child."conversation_id",
		parent."root_conversation_id"
	FROM "junior_conversations" child
	JOIN "conversation_roots" parent
		ON child."parent_conversation_id" = parent."conversation_id"
)
UPDATE "junior_conversations" conversation
SET "root_conversation_id" = roots."root_conversation_id"
FROM "conversation_roots" roots
WHERE conversation."conversation_id" = roots."conversation_id";--> statement-breakpoint
ALTER TABLE "junior_conversations" ADD CONSTRAINT "junior_conversations_root_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("root_conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_conversations_root_idx" ON "junior_conversations" USING btree ("root_conversation_id");
