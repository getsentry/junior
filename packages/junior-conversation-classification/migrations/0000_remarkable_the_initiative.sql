CREATE TABLE "junior_conversation_classifications" (
	"task_id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"taxonomy_version" text NOT NULL,
	"category_id" text NOT NULL,
	"confidence" double precision NOT NULL,
	"model_id" text,
	"owner_key" text NOT NULL,
	"visibility" text NOT NULL,
	"turn_completed_at_ms" bigint NOT NULL,
	"classified_at_ms" bigint NOT NULL,
	"expires_at_ms" bigint NOT NULL,
	CONSTRAINT "junior_conversation_classifications_confidence_check" CHECK ("junior_conversation_classifications"."confidence" >= 0 AND "junior_conversation_classifications"."confidence" <= 1)
);
--> statement-breakpoint
CREATE INDEX "junior_conversation_classifications_category_idx" ON "junior_conversation_classifications" USING btree ("taxonomy_version","category_id");--> statement-breakpoint
CREATE INDEX "junior_conversation_classifications_conversation_idx" ON "junior_conversation_classifications" USING btree ("conversation_id","turn_completed_at_ms");--> statement-breakpoint
CREATE INDEX "junior_conversation_classifications_expiry_idx" ON "junior_conversation_classifications" USING btree ("expires_at_ms");