ALTER TABLE "junior_conversation_metrics" ADD COLUMN "actor_identity_id" text;--> statement-breakpoint
ALTER TABLE "junior_conversation_metrics" ADD CONSTRAINT "junior_conversation_metrics_actor_identity_id_junior_identities_id_fk" FOREIGN KEY ("actor_identity_id") REFERENCES "public"."junior_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_conversation_metrics_actor_identity_occurred_at_idx" ON "junior_conversation_metrics" USING btree ("actor_identity_id","occurred_at");--> statement-breakpoint
-- Old metric rows do not record their Turn Actor. Use the Actor of the
-- metric row's Conversation, else the Actor of its root.
UPDATE "junior_conversation_metrics" AS "m"
SET "actor_identity_id" = coalesce("c"."actor_identity_id", "r"."actor_identity_id")
FROM "junior_conversations" AS "c"
LEFT JOIN "junior_conversations" AS "r"
  ON "r"."conversation_id" = coalesce("c"."root_conversation_id", "c"."conversation_id")
WHERE "c"."conversation_id" = "m"."conversation_id"
  AND "m"."actor_identity_id" IS NULL;
