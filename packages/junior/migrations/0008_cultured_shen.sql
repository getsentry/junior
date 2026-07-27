CREATE TABLE "junior_conversation_annotations" (
	"conversation_id" text NOT NULL,
	"plugin" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"annotation_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_conversation_annotations_pk" PRIMARY KEY("conversation_id","plugin","kind","key")
);
--> statement-breakpoint
ALTER TABLE "junior_conversation_annotations" ADD CONSTRAINT "junior_conversation_annotations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;