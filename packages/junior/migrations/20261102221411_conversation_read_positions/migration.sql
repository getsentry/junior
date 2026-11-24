CREATE TABLE "junior_conversation_read_positions" (
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"last_read_seq" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_conversation_read_positions_user_conversation_pk" PRIMARY KEY("user_id","conversation_id")
);
--> statement-breakpoint
ALTER TABLE "junior_conversation_read_positions" ADD CONSTRAINT "junior_conversation_read_positions_user_id_junior_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."junior_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_conversation_read_positions" ADD CONSTRAINT "junior_conversation_read_positions_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE no action ON UPDATE no action;