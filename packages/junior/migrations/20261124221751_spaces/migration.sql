CREATE TABLE "junior_space_members" (
	"space_id" text,
	"user_id" text,
	"joined_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_space_members_space_user_pk" PRIMARY KEY("space_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "junior_spaces" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"description" text,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "junior_space_members_user_idx" ON "junior_space_members" ("user_id");--> statement-breakpoint
CREATE INDEX "junior_spaces_updated_idx" ON "junior_spaces" ("updated_at" DESC NULLS LAST,"id");--> statement-breakpoint
ALTER TABLE "junior_space_members" ADD CONSTRAINT "junior_space_members_space_id_junior_spaces_id_fkey" FOREIGN KEY ("space_id") REFERENCES "junior_spaces"("id");--> statement-breakpoint
ALTER TABLE "junior_space_members" ADD CONSTRAINT "junior_space_members_user_id_junior_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "junior_users"("id");--> statement-breakpoint
ALTER TABLE "junior_spaces" ADD CONSTRAINT "junior_spaces_created_by_user_id_junior_users_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "junior_users"("id");