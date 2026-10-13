CREATE TABLE "junior_memory_signals" (
	"memory_id" text NOT NULL,
	"signal" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"conversation_id" text,
	"observed_at_ms" bigint NOT NULL,
	CONSTRAINT "junior_memory_signals_memory_id_signal_idempotency_key_pk" PRIMARY KEY("memory_id","signal","idempotency_key"),
	CONSTRAINT "junior_memory_signals_signal_check" CHECK ("junior_memory_signals"."signal" IN ('duplicate'))
);
--> statement-breakpoint
ALTER TABLE "junior_memory_signals" ADD CONSTRAINT "junior_memory_signals_memory_id_junior_memory_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."junior_memory_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_memory_signals_observed_idx" ON "junior_memory_signals" USING btree ("memory_id","signal","observed_at_ms");