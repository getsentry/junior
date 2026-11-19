ALTER TABLE "junior_artifacts" ADD COLUMN "path" text;--> statement-breakpoint
-- Every existing row is a public frozen copy with no path. NOT VALID skips
-- the scan under lock and still checks every new write.
ALTER TABLE "junior_artifacts" ADD CONSTRAINT "junior_artifacts_path_visibility_check" CHECK (("junior_artifacts"."path" is null) = ("junior_artifacts"."visibility" = 'public')) NOT VALID;
