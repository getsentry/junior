CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "junior_conversation_brief_embeddings" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"brief_version" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"embedding" vector NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "junior_conversation_brief_embeddings_dimensions_check" CHECK (vector_dims("junior_conversation_brief_embeddings"."embedding") = "junior_conversation_brief_embeddings"."dimensions")
);
--> statement-breakpoint
ALTER TABLE "junior_conversation_brief_embeddings" ADD CONSTRAINT "junior_conversation_brief_embeddings_brief_fk" FOREIGN KEY ("conversation_id","brief_version") REFERENCES "public"."junior_conversation_briefs"("conversation_id","version") ON DELETE cascade ON UPDATE no action;