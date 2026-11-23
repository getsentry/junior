ALTER TABLE "junior_inbox_items" DROP CONSTRAINT "junior_inbox_items_kind_check";--> statement-breakpoint
ALTER TABLE "junior_inbox_items" DROP CONSTRAINT "junior_inbox_items_owner_check";--> statement-breakpoint
DROP INDEX "junior_inbox_items_open_dedupe_uidx";--> statement-breakpoint
ALTER TABLE "junior_inbox_items" ADD COLUMN "subject_kind" text;--> statement-breakpoint
-- Each item gets its subject. The kind comes from the old key prefix, and a
-- GitHub pull request item also uses its title: one item showed both the
-- review ask and the merge ask. The id is the subject link when the item
-- had one. The key loses its prefix, because the subject namespace now
-- scopes it. `automation_id` needs no copy: the run of the owner
-- Conversation names the same Automation.
--
-- Old workers still add items without a subject while this release rolls
-- out, so a trigger gives each such row its subject by the same rules. The
-- backfill below fires the same trigger.
CREATE OR REPLACE FUNCTION "junior_inbox_items_legacy_subject"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW."subject_kind" := CASE
      WHEN NEW."owner_kind" = 'automation' THEN 'automation'
      WHEN NEW."dedupe_key" LIKE 'plugin:github:pull-request-action:%' THEN
        CASE WHEN NEW."title" LIKE 'Ready to merge%' THEN 'github:pull_request_merge' ELSE 'github:pull_request_review' END
      WHEN NEW."dedupe_key" LIKE 'plugin:github:pull-request-ready:%' THEN 'github:pull_request_merge'
      WHEN NEW."dedupe_key" LIKE 'plugin:github:pull-request-review-requested:%' THEN 'github:pull_request_review'
      WHEN NEW."dedupe_key" LIKE 'plugin:github:merge-conflict:%' THEN 'github:merge_conflict'
      WHEN NEW."dedupe_key" LIKE 'plugin:%' THEN split_part(NEW."dedupe_key", ':', 2) || ':item'
      WHEN NEW."dedupe_key" LIKE 'reply:%' THEN 'reply'
      WHEN NEW."dedupe_key" LIKE 'todo:%' THEN 'todo'
      ELSE 'agent'
    END;
  NEW."subject_id" := CASE
      WHEN NEW."owner_kind" = 'automation' THEN NEW."owner_id"
      WHEN NEW."dedupe_key" LIKE 'reply:%' THEN NEW."owner_id"
      WHEN NEW."dedupe_key" LIKE 'todo:%' THEN substr(NEW."dedupe_key", length('todo:') + 1)
      WHEN NEW."dedupe_key" LIKE 'plugin:%' THEN coalesce(NEW."subject_url", NEW."subject_id", substr(NEW."dedupe_key", length('plugin:' || split_part(NEW."dedupe_key", ':', 2) || ':') + 1))
      ELSE coalesce(NEW."subject_url", NEW."subject_id", NEW."dedupe_key")
    END;
  -- The key changes last, because the rules above read the old key.
  NEW."dedupe_key" := CASE
      WHEN NEW."dedupe_key" LIKE 'plugin:%' THEN substr(NEW."dedupe_key", length('plugin:' || split_part(NEW."dedupe_key", ':', 2) || ':') + 1)
      WHEN NEW."dedupe_key" LIKE 'automation:%' THEN substr(NEW."dedupe_key", length('automation:') + 1)
      WHEN NEW."dedupe_key" LIKE 'reply:%' THEN substr(NEW."dedupe_key", length('reply:') + 1)
      WHEN NEW."dedupe_key" LIKE 'todo:%' THEN substr(NEW."dedupe_key", length('todo:') + 1)
      ELSE NEW."dedupe_key"
    END;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "junior_inbox_items_legacy_subject" BEFORE INSERT OR UPDATE ON "junior_inbox_items" FOR EACH ROW WHEN (NEW."subject_kind" IS NULL) EXECUTE FUNCTION "junior_inbox_items_legacy_subject"();--> statement-breakpoint
-- junior:bounded-backfill: every row needs its subject before 0171 sets NOT NULL, so the update runs once over the whole Inbox item table. That table holds only asks and notices for people, and the update writes each row once.
UPDATE "junior_inbox_items" SET "subject_kind" = NULL;--> statement-breakpoint
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
