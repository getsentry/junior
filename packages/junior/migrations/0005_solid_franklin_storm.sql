CREATE TABLE "junior_conversation_turns" (
	"conversation_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"starting_seq" integer NOT NULL,
	CONSTRAINT "junior_conversation_turns_conversation_id_turn_id_pk" PRIMARY KEY("conversation_id","turn_id")
);
--> statement-breakpoint
ALTER TABLE "junior_conversation_turns" ADD CONSTRAINT "junior_conversation_turns_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_conversation_turns" ADD CONSTRAINT "junior_conversation_turns_starting_step_fk" FOREIGN KEY ("conversation_id","starting_seq") REFERENCES "public"."junior_agent_steps"("conversation_id","seq") ON DELETE no action ON UPDATE no action;