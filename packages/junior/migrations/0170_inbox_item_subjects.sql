ALTER TABLE "junior_inbox_items" DROP CONSTRAINT "junior_inbox_items_kind_check";--> statement-breakpoint
ALTER TABLE "junior_inbox_items" DROP CONSTRAINT "junior_inbox_items_owner_check";--> statement-breakpoint
DROP INDEX "junior_inbox_items_open_dedupe_uidx";--> statement-breakpoint
ALTER TABLE "junior_inbox_items" ADD COLUMN "subject_kind" text;--> statement-breakpoint
ALTER TABLE "junior_inbox_items" ALTER COLUMN "dedupe_key" DROP NOT NULL;--> statement-breakpoint
-- Each item gets its subject. The kind comes from the old key prefix. The
-- subject kind and id now name the item, so new code writes no dedupe key.
-- A GitHub pull request has one item for all of its asks, and its id is
-- GitHub's id of the pull request, read from the code change records by the
-- repository and number in the old key. A plugin or agent item uses its
-- subject link as the id when it had one. `automation_id` needs no copy:
-- the run of the owner Conversation names the same Automation.
--
-- Old workers still add items without a subject while this release rolls
-- out, so a trigger gives each such row its subject by the same rules. The
-- backfill below fires the same trigger.
CREATE OR REPLACE FUNCTION "junior_inbox_items_legacy_subject"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  github_ref text := CASE
      WHEN NEW."dedupe_key" ~ '^plugin:github:(pull-request-action|pull-request-ready|pull-request-review-requested|merge-conflict):[^#]+#[0-9]+$'
        THEN regexp_replace(NEW."dedupe_key", '^plugin:github:[a-z-]+:', '')
    END;
  github_id text;
BEGIN
  IF github_ref IS NOT NULL THEN
    SELECT c."provider_id" INTO github_id
    FROM "junior_code_changes" c
    JOIN "junior_code_repositories" r ON r."id" = c."repository_id"
    WHERE c."provider" = 'github'
      AND lower(r."name") = lower(split_part(github_ref, '#', 1))
      AND c."number" = split_part(github_ref, '#', 2)::integer
    LIMIT 1;
  END IF;
  NEW."subject_kind" := CASE
      WHEN NEW."owner_kind" = 'automation' THEN 'automation'
      WHEN NEW."dedupe_key" LIKE 'plugin:github:merge-conflict:%' THEN 'github:merge_conflict'
      WHEN github_ref IS NOT NULL THEN 'github:pull_request'
      WHEN NEW."dedupe_key" LIKE 'plugin:%' THEN split_part(NEW."dedupe_key", ':', 2) || ':item'
      WHEN NEW."dedupe_key" LIKE 'reply:%' THEN 'reply'
      WHEN NEW."dedupe_key" LIKE 'todo:%' THEN 'todo'
      ELSE 'agent'
    END;
  NEW."subject_id" := CASE
      WHEN NEW."owner_kind" = 'automation' THEN NEW."owner_id"
      WHEN NEW."dedupe_key" LIKE 'reply:%' THEN NEW."owner_id"
      WHEN NEW."dedupe_key" LIKE 'todo:%' THEN substr(NEW."dedupe_key", length('todo:') + 1)
      WHEN github_ref IS NOT NULL THEN coalesce(github_id, NEW."subject_url", github_ref)
      WHEN NEW."dedupe_key" LIKE 'plugin:%' THEN coalesce(NEW."subject_url", NEW."subject_id", substr(NEW."dedupe_key", length('plugin:' || split_part(NEW."dedupe_key", ':', 2) || ':') + 1))
      ELSE coalesce(NEW."subject_url", NEW."subject_id", NEW."dedupe_key")
    END;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "junior_inbox_items_legacy_subject" BEFORE INSERT OR UPDATE ON "junior_inbox_items" FOR EACH ROW WHEN (NEW."subject_kind" IS NULL) EXECUTE FUNCTION "junior_inbox_items_legacy_subject"();--> statement-breakpoint
-- junior:bounded-backfill: every row needs its subject before 0171 sets NOT NULL, so the update runs once over the whole Inbox item table. That table holds only asks and notices for people, and the update writes each row once.
UPDATE "junior_inbox_items" SET "subject_kind" = NULL;--> statement-breakpoint
-- junior:bounded-backfill: before 0172 adds the unique open subject index, the older of two open items that now share a subject closes. It reads only the open items and closes the few duplicates, such as the review and merge asks of one pull request.
UPDATE "junior_inbox_items" AS "item" SET "status" = 'dismissed', "closed_at" = now(), "close_reason" = 'A newer item asks about the same subject.', "updated_at" = now() WHERE "item"."status" = 'open' AND EXISTS (SELECT 1 FROM "junior_inbox_items" AS "newer" WHERE "newer"."status" = 'open' AND coalesce("newer"."provider", '') = coalesce("item"."provider", '') AND coalesce("newer"."provider_tenant_id", '') = coalesce("item"."provider_tenant_id", '') AND "newer"."subject_kind" = "item"."subject_kind" AND "newer"."subject_id" = "item"."subject_id" AND ("newer"."updated_at", "newer"."id") > ("item"."updated_at", "item"."id"));--> statement-breakpoint
-- NOT VALID: the backfill gave every row its subject, and the checks still
-- hold for every new write. 0171 validates the NOT NULL checks without a
-- lock that blocks reads, then sets NOT NULL.
ALTER TABLE "junior_inbox_items" ADD CONSTRAINT "junior_inbox_items_subject_kind_not_null" CHECK ("subject_kind" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "junior_inbox_items" ADD CONSTRAINT "junior_inbox_items_subject_id_not_null" CHECK ("subject_id" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "junior_inbox_items" ADD CONSTRAINT "junior_inbox_items_kind_check" CHECK (("junior_inbox_items"."kind" = 'notice' and "junior_inbox_items"."request" is null and "junior_inbox_items"."answer" is null) or ("junior_inbox_items"."kind" = 'action' and ("junior_inbox_items"."request" is not null or ("junior_inbox_items"."subject_kind" not in ('agent', 'reply') and "junior_inbox_items"."answer" is null)))) NOT VALID;--> statement-breakpoint
ALTER TABLE "junior_inbox_items" ADD CONSTRAINT "junior_inbox_items_owner_check" CHECK (("junior_inbox_items"."owner_kind" = 'automation') = ("junior_inbox_items"."subject_kind" = 'automation')) NOT VALID;
-- The snapshot no longer has subject_title, subject_url, subject_title_parts,
-- automation_id, its foreign key, or junior_inbox_items_automation_idx. They
-- stay in the database for one release, because old workers still name them
-- in every insert while this migration runs. The next release drops them
-- with the trigger above.
