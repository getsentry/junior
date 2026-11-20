CREATE TABLE "junior_review_item_slack_cards" (
	"item_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_ts" text NOT NULL,
	CONSTRAINT "junior_review_item_slack_cards_item_id_conversation_id_pk" PRIMARY KEY("item_id","conversation_id")
);
--> statement-breakpoint
ALTER TABLE "junior_review_item_slack_cards" ADD CONSTRAINT "junior_review_item_slack_cards_item_id_junior_review_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."junior_review_items"("id") ON DELETE cascade ON UPDATE no action;