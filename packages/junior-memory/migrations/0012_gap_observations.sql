CREATE TABLE "junior_memory_gap_captures" (
	"turn_id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"captured_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "junior_memory_gaps" (
	"id" text PRIMARY KEY NOT NULL,
	"turn_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"scope" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"description" text NOT NULL,
	"explanation" text NOT NULL,
	"category" text NOT NULL,
	"impact" text NOT NULL,
	"evidence_message_indices" jsonb NOT NULL,
	"evidence_kind" text NOT NULL,
	"observed_at_ms" bigint NOT NULL,
	"review_state" text DEFAULT 'unreviewed' NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at_ms" bigint,
	CONSTRAINT "junior_memory_gaps_scope_check" CHECK ("junior_memory_gaps"."scope" IN ('private', 'public')),
	CONSTRAINT "junior_memory_gaps_category_check" CHECK ("junior_memory_gaps"."category" IN ('knowledge', 'capability', 'permission', 'tool_failure')),
	CONSTRAINT "junior_memory_gaps_impact_check" CHECK ("junior_memory_gaps"."impact" IN ('blocked', 'workaround', 'uncertain_answer')),
	CONSTRAINT "junior_memory_gaps_review_check" CHECK ("junior_memory_gaps"."review_state" IN ('unreviewed', 'confirmed', 'dismissed')),
	CONSTRAINT "junior_memory_gaps_evidence_check" CHECK ("junior_memory_gaps"."evidence_kind" IN ('tool', 'reported'))
);
--> statement-breakpoint
ALTER TABLE "junior_memory_gaps" ADD CONSTRAINT "junior_memory_gaps_turn_id_junior_memory_gap_captures_turn_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."junior_memory_gap_captures"("turn_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_memory_gaps_visible_idx" ON "junior_memory_gaps" USING btree ("scope","owner_user_id","observed_at_ms" DESC NULLS LAST,"id");