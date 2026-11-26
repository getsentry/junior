ALTER TABLE "junior_inbox_items" ADD COLUMN "subject_kind" text;--> statement-breakpoint
-- Each item gets its subject. The kind comes from the old key prefix. The
-- subject kind and id now name the item. New code still gets a dedupe key,
-- and the other old columns and checks stay, so the release before this
-- one can still read and write every row after a rollback
-- (20261126034025_inbox_item_owners). A later release drops them.
-- A GitHub pull request has one item for all of its asks, and its id is
-- GitHub's id of the pull request, read from the code change records by the
-- repository and number in the old key, or else by the number and the owner
-- Conversation, after a repository rename. A plugin item uses its subject
-- link as the id when it had one. An agent's item is a question, and its
-- old key is its id, so two questions about one object stay two items. Its
-- old subject link, in `subject_url` or else in `subject_id`, becomes its
-- first evidence link. A notice keeps no request, so its link stays in
-- `subject_url`, and its question reads it from there
-- (20261126033259_inbox_questions).
-- `automation_id` needs no copy:
-- the run of the owner Conversation names the same Automation.
--
-- Old workers still add items without a subject while this release rolls
-- out, so a trigger gives each such row its subject by the same rules. The
-- backfill below fires the same trigger.
--
-- New code stores each http(s) evidence link as `URL.href`, so a link
-- matches the same link that another item cites. Postgres has no URL
-- parser, so this function makes only the common changes of `URL.href`: it
-- lowercases the scheme and host, and gives a bare origin its `/`. It goes
-- with the legacy trigger.
CREATE OR REPLACE FUNCTION "junior_inbox_items_web_link"(link text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT lower(origin) || CASE WHEN rest = '' OR left(rest, 1) IN ('?', '#') THEN '/' || rest ELSE rest END
  FROM (SELECT substring(link from '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*') AS origin) AS parts,
  LATERAL (SELECT substr(link, length(origin) + 1) AS rest) AS tail
$function$;--> statement-breakpoint
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
  -- An agent item kept its link in `subject_url`, or else in `subject_id`.
  legacy_link text := "junior_inbox_items_web_link"(CASE
      WHEN NEW."subject_url" ~* '^https?://' THEN NEW."subject_url"
      WHEN NEW."subject_id" ~* '^https?://' THEN NEW."subject_id"
    END);
BEGIN
  IF github_ref IS NOT NULL THEN
    SELECT c."provider_id" INTO github_id
    FROM "junior_code_changes" c
    JOIN "junior_code_repositories" r ON r."id" = c."repository_id"
    WHERE c."provider" = 'github'
      AND lower(r."name") = lower(split_part(github_ref, '#', 1))
      AND c."number" = split_part(github_ref, '#', 2)::integer
    LIMIT 1;
    -- A renamed repository no longer matches the name in the key. Then the
    -- change with that number that the owner Conversation opened names the
    -- id, when only one change matches.
    IF github_id IS NULL AND NEW."owner_kind" = 'conversation' THEN
      SELECT min(c."provider_id") INTO github_id
      FROM "junior_code_changes" c
      WHERE c."provider" = 'github'
        AND c."number" = split_part(github_ref, '#', 2)::integer
        AND c."conversation_ids" @> ARRAY[NEW."owner_id"]
      HAVING count(*) = 1;
    END IF;
  END IF;
  NEW."subject_kind" := CASE
      WHEN NEW."owner_kind" = 'automation' THEN 'automation'
      WHEN NEW."dedupe_key" LIKE 'plugin:github:merge-conflict:%' THEN 'github:merge_conflict'
      WHEN github_ref IS NOT NULL THEN 'github:pull_request'
      WHEN NEW."dedupe_key" LIKE 'plugin:%' THEN split_part(NEW."dedupe_key", ':', 2) || ':item'
      WHEN NEW."dedupe_key" LIKE 'reply:%' THEN 'reply'
      WHEN NEW."dedupe_key" LIKE 'todo:%' THEN 'todo'
      ELSE 'question'
    END;
  NEW."subject_id" := CASE
      WHEN NEW."owner_kind" = 'automation' THEN NEW."owner_id"
      WHEN NEW."dedupe_key" LIKE 'reply:%' THEN NEW."owner_id"
      WHEN NEW."dedupe_key" LIKE 'todo:%' THEN substr(NEW."dedupe_key", length('todo:') + 1)
      WHEN github_ref IS NOT NULL THEN coalesce(github_id, NEW."subject_url", github_ref)
      WHEN NEW."dedupe_key" LIKE 'plugin:%' THEN coalesce(NEW."subject_url", NEW."subject_id", substr(NEW."dedupe_key", length('plugin:' || split_part(NEW."dedupe_key", ':', 2) || ':') + 1))
      ELSE coalesce(NEW."dedupe_key", 'ask:' || NEW."id"::text)
    END;
  -- Every item's http(s) evidence links get the form that new code stores,
  -- also a closed item's, so the duplicate check below sees its old link.
  IF jsonb_typeof(NEW."request"->'evidence') = 'array' THEN
    NEW."request" := jsonb_set(NEW."request", '{evidence}', (SELECT coalesce(jsonb_agg(CASE WHEN entry->>'url' ~* '^https?://' THEN jsonb_set(entry, '{url}', to_jsonb("junior_inbox_items_web_link"(entry->>'url'))) ELSE entry END ORDER BY position), '[]'::jsonb) FROM jsonb_array_elements(NEW."request"->'evidence') WITH ORDINALITY AS evidence(entry, position)));
  END IF;
  -- A question reads what it is about from its evidence links, so its old
  -- subject link becomes its first evidence link. A notice keeps no request,
  -- because the old kind check still holds, so its link stays in
  -- `subject_url`.
  IF NEW."subject_kind" = 'question' AND NEW."kind" = 'notice' AND legacy_link IS NOT NULL THEN
    NEW."subject_url" := legacy_link;
  ELSIF NEW."subject_kind" = 'question'
    AND legacy_link IS NOT NULL
    AND NOT coalesce(NEW."request"->'evidence', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('url', legacy_link))
  THEN
    NEW."request" := jsonb_set(coalesce(NEW."request", '{}'::jsonb), '{evidence}', jsonb_build_array(jsonb_build_object('label', left(coalesce(nullif(NEW."subject_title", ''), legacy_link), 120), 'url', legacy_link)) || coalesce(NEW."request"->'evidence', '[]'::jsonb));
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "junior_inbox_items_legacy_subject" BEFORE INSERT OR UPDATE ON "junior_inbox_items" FOR EACH ROW WHEN (NEW."subject_kind" IS NULL) EXECUTE FUNCTION "junior_inbox_items_legacy_subject"();--> statement-breakpoint
-- junior:bounded-backfill: every row needs its subject before the next migration sets NOT NULL, so the update runs once over the whole Inbox item table. That table holds only asks and notices for people, and the update writes each row once. The same write gives the evidence links of every row the stored form.
UPDATE "junior_inbox_items" SET "subject_kind" = NULL;--> statement-breakpoint
-- junior:bounded-backfill: before the unique open subject index below, the older of two open items that now share a subject closes. It reads only the open items and closes the few duplicates, such as the review and merge asks of one pull request.
UPDATE "junior_inbox_items" AS "item" SET "status" = 'dismissed', "closed_at" = now(), "close_reason" = 'A newer item asks about the same subject.', "updated_at" = now() WHERE "item"."status" = 'open' AND EXISTS (SELECT 1 FROM "junior_inbox_items" AS "newer" WHERE "newer"."status" = 'open' AND coalesce("newer"."provider", '') = coalesce("item"."provider", '') AND coalesce("newer"."provider_tenant_id", '') = coalesce("item"."provider_tenant_id", '') AND "newer"."subject_kind" = "item"."subject_kind" AND "newer"."subject_id" = "item"."subject_id" AND ("newer"."updated_at", "newer"."id") > ("item"."updated_at", "item"."id"));--> statement-breakpoint
-- junior:bounded-backfill: a snooze of a closed duplicate moves to the item that stays open, so that item stays hidden. It reads only the snoozes of the few duplicates. A person who also snoozed the open item keeps that snooze: its wake time is in the timer store, not here.
UPDATE "junior_inbox_snoozes" AS "snooze" SET "inbox_item_id" = "move"."open_id" FROM (SELECT DISTINCT ON ("snooze"."user_id", "open"."id") "snooze"."id", "open"."id" AS "open_id" FROM "junior_inbox_snoozes" AS "snooze" JOIN "junior_inbox_items" AS "item" ON "item"."id" = "snooze"."inbox_item_id" JOIN "junior_inbox_items" AS "open" ON "open"."status" = 'open' AND coalesce("open"."provider", '') = coalesce("item"."provider", '') AND coalesce("open"."provider_tenant_id", '') = coalesce("item"."provider_tenant_id", '') AND "open"."subject_kind" = "item"."subject_kind" AND "open"."subject_id" = "item"."subject_id" WHERE "snooze"."state" = 'snoozed' AND "item"."status" = 'dismissed' AND "item"."close_reason" = 'A newer item asks about the same subject.' AND NOT EXISTS (SELECT 1 FROM "junior_inbox_snoozes" AS "kept" WHERE "kept"."inbox_item_id" = "open"."id" AND "kept"."user_id" = "snooze"."user_id" AND "kept"."state" = 'snoozed') ORDER BY "snooze"."user_id", "open"."id", "snooze"."created_at" DESC) AS "move" WHERE "snooze"."id" = "move"."id";--> statement-breakpoint
-- junior:bounded-backfill: the assignees of a closed duplicate join the item that stays open, so they keep their ask. It reads only the assignees of the few duplicates. An open item with no assignees asks everyone, so it gets none.
INSERT INTO "junior_inbox_item_assignees" ("item_id", "user_id") SELECT DISTINCT "open"."id", "assignee"."user_id" FROM "junior_inbox_item_assignees" AS "assignee" JOIN "junior_inbox_items" AS "item" ON "item"."id" = "assignee"."item_id" JOIN "junior_inbox_items" AS "open" ON "open"."status" = 'open' AND coalesce("open"."provider", '') = coalesce("item"."provider", '') AND coalesce("open"."provider_tenant_id", '') = coalesce("item"."provider_tenant_id", '') AND "open"."subject_kind" = "item"."subject_kind" AND "open"."subject_id" = "item"."subject_id" WHERE "item"."status" = 'dismissed' AND "item"."close_reason" = 'A newer item asks about the same subject.' AND EXISTS (SELECT 1 FROM "junior_inbox_item_assignees" AS "kept" WHERE "kept"."item_id" = "open"."id") ON CONFLICT DO NOTHING;--> statement-breakpoint
-- junior:bounded-backfill: the sent pushes of a closed duplicate clear, as for any closed item, so the devices close it. It reads only the deliveries of the few duplicates.
UPDATE "junior_inbox_item_deliveries" AS "delivery" SET "status" = 'cleared', "updated_at" = now() FROM "junior_inbox_items" AS "item" WHERE "item"."id" = "delivery"."item_id" AND "delivery"."status" = 'sent' AND "item"."status" = 'dismissed' AND "item"."close_reason" = 'A newer item asks about the same subject.';--> statement-breakpoint
-- The subject now names an open item. The index is built here, in the
-- transaction that closed the duplicates, so an old worker cannot add a
-- second open item for a subject while this release rolls out. That insert
-- fails instead. It reads only the open items.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "junior_inbox_items_open_subject_uidx" ON "junior_inbox_items" USING btree (coalesce("provider", ''),coalesce("provider_tenant_id", ''),"subject_kind","subject_id") WHERE "junior_inbox_items"."status" = 'open';--> statement-breakpoint
-- NOT VALID: the backfill gave every row its subject, and the checks still
-- hold for every new write. The next migration validates the NOT NULL checks without a
-- lock that blocks reads, then sets NOT NULL.
ALTER TABLE "junior_inbox_items" ADD CONSTRAINT "junior_inbox_items_subject_kind_not_null" CHECK ("subject_kind" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "junior_inbox_items" ADD CONSTRAINT "junior_inbox_items_subject_id_not_null" CHECK ("subject_id" IS NOT NULL) NOT VALID;
-- The snapshot no longer has subject_title, subject_url, subject_title_parts,
-- automation_id, its foreign key, junior_inbox_items_automation_idx, or
-- junior_inbox_items_open_dedupe_uidx. That index still lets an old worker
-- add only one open item per dedupe key, because a question it adds gets
-- the item's id as its subject (20261126033259_inbox_questions). They
-- stay in the database for one release, because old workers still name them
-- in every insert while this migration runs. The next release drops them
-- with the trigger above.
