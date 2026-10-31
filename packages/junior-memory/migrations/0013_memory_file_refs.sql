CREATE TABLE "junior_memory_file_refs" (
	"memory_id" text NOT NULL,
	"path" text NOT NULL,
	"conversation_id" text,
	"observed_at_ms" bigint NOT NULL,
	CONSTRAINT "junior_memory_file_refs_memory_id_path_pk" PRIMARY KEY("memory_id","path")
);
--> statement-breakpoint
ALTER TABLE "junior_memory_file_refs" ADD CONSTRAINT "junior_memory_file_refs_memory_id_junior_memory_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."junior_memory_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_memory_file_refs_path_idx" ON "junior_memory_file_refs" USING btree ("path");