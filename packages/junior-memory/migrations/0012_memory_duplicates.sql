CREATE TABLE "junior_memory_duplicates" (
	"memory_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"reason" text NOT NULL,
	"conversation_id" text,
	"observed_at_ms" bigint NOT NULL,
	CONSTRAINT "junior_memory_duplicates_memory_id_idempotency_key_pk" PRIMARY KEY("memory_id","idempotency_key"),
	CONSTRAINT "junior_memory_duplicates_reason_check" CHECK ("junior_memory_duplicates"."reason" IN ('exact', 'semantic'))
);
--> statement-breakpoint
ALTER TABLE "junior_memory_duplicates" ADD CONSTRAINT "junior_memory_duplicates_memory_id_junior_memory_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."junior_memory_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_memory_duplicates_observed_idx" ON "junior_memory_duplicates" USING btree ("memory_id","observed_at_ms");