CREATE TABLE "junior_conversation_event_embeddings" (
	"conversation_id" text NOT NULL,
	"seq" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"embedding" vector NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "junior_conversation_event_embeddings_pk" PRIMARY KEY("conversation_id","seq"),
	CONSTRAINT "junior_conversation_event_embeddings_dimensions_check" CHECK (vector_dims("junior_conversation_event_embeddings"."embedding") = "junior_conversation_event_embeddings"."dimensions")
);
--> statement-breakpoint
ALTER TABLE "junior_conversation_event_embeddings" ADD CONSTRAINT "junior_conversation_event_embeddings_event_fk" FOREIGN KEY ("conversation_id","seq") REFERENCES "public"."junior_conversation_events"("conversation_id","seq") ON DELETE cascade ON UPDATE no action;