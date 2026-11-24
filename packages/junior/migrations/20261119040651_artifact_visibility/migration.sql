-- `visibility` replaces `public`. publishImage is the only writer, and it
-- always wrote `public = true`, so the 'public' default is right for every
-- existing row. The defaults on both columns keep the previous runtime's
-- inserts valid during rollout.
ALTER TABLE "junior_artifacts" ALTER COLUMN "public" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "junior_artifacts" ADD COLUMN "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
-- Every existing row is 'public' here. NOT VALID skips the scan under lock
-- and still checks every new write.
ALTER TABLE "junior_artifacts" ADD CONSTRAINT "junior_artifacts_visibility_check" CHECK ("junior_artifacts"."visibility" in ('conversation', 'internal', 'public')) NOT VALID;
