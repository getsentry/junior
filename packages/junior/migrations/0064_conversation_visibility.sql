ALTER TABLE "junior_conversations" ADD COLUMN "visibility" text;--> statement-breakpoint
-- Copy known Destination visibility to each root Conversation. No released
-- writer can make one Conversation in a DM public yet, so the shared value is
-- still correct for every Conversation at that Destination.
UPDATE "junior_conversations" AS conversation
SET "visibility" = destination."visibility"
FROM "junior_destinations" AS destination
WHERE destination."id" = conversation."destination_id"
	AND conversation."parent_conversation_id" IS NULL
	AND destination."visibility" IN ('public', 'private');
