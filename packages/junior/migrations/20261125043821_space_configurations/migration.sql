CREATE TABLE "junior_space_configurations" (
	"space_id" text,
	"key" text,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by_user_id" text,
	CONSTRAINT "junior_space_configurations_space_key_pk" PRIMARY KEY("space_id","key")
);
--> statement-breakpoint
ALTER TABLE "junior_space_configurations" ADD CONSTRAINT "junior_space_configurations_space_id_junior_spaces_id_fkey" FOREIGN KEY ("space_id") REFERENCES "junior_spaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "junior_space_configurations" ADD CONSTRAINT "junior_space_configurations_FQKCei7Jay3p_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "junior_users"("id") ON DELETE SET NULL;