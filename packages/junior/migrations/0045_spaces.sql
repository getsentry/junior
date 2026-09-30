CREATE TABLE "junior_conversation_spaces" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"assigned_by" text NOT NULL,
	"confidence" double precision,
	"pinned" boolean DEFAULT false NOT NULL,
	"turn_id" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "junior_space_changes" (
	"change_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"space_id" text NOT NULL,
	"conversation_id" text,
	"actor_kind" text NOT NULL,
	"actor_conversation_id" text,
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "junior_spaces" (
	"space_id" text PRIMARY KEY NOT NULL,
	"parent_space_id" text,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"merged_into_space_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "junior_conversation_spaces" ADD CONSTRAINT "junior_conversation_spaces_space_id_junior_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."junior_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_conversation_spaces" ADD CONSTRAINT "junior_conversation_spaces_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_spaces" ADD CONSTRAINT "junior_spaces_parent_space_id_junior_spaces_space_id_fk" FOREIGN KEY ("parent_space_id") REFERENCES "public"."junior_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_spaces" ADD CONSTRAINT "junior_spaces_merged_into_space_id_junior_spaces_space_id_fk" FOREIGN KEY ("merged_into_space_id") REFERENCES "public"."junior_spaces"("space_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_conversation_spaces_space_idx" ON "junior_conversation_spaces" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "junior_space_changes_space_idx" ON "junior_space_changes" USING btree ("space_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "junior_space_changes_conversation_idx" ON "junior_space_changes" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "junior_spaces_parent_idx" ON "junior_spaces" USING btree ("parent_space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "junior_spaces_active_sibling_name_idx" ON "junior_spaces" USING btree (coalesce("parent_space_id", ''),lower("name")) WHERE "junior_spaces"."status" = 'active';