-- New code reads the owner, visibility, and provider tenant of an Inbox item
-- from its subject (`chat/inbox-items/owner.ts`), and its schema no longer
-- names `dedupe_key`, `owner_kind`, `owner_id`, or `visibility`. They keep
-- their NOT NULL and their checks for one release, so the release before
-- this one can still read and write every row after a rollback. This
-- trigger writes them for new code: the owner that the code adding the item
-- names (`junior.inbox_item_owner_kind` and `junior.inbox_item_owner_id`,
-- set for its transaction), a dedupe key in the old form of its subject
-- kind, and the owner's visibility: its Destination's, but private while
-- an owner Conversation is private. A question item gets a copy of its
-- question's title and body, and an action also gets a copy of its
-- request, which the old kind check needs. An old worker writes all
-- of them itself, so the trigger leaves its rows alone. A later release
-- drops the trigger with the old columns and checks. Its name sorts after
-- `junior_inbox_items_legacy_subject_question`, so an old worker's question
-- item has its content before it runs.
CREATE OR REPLACE FUNCTION "junior_inbox_items_legacy_write"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  question record;
BEGIN
  IF TG_OP = 'INSERT' AND NEW."dedupe_key" IS NULL THEN
    NEW."owner_kind" := nullif(current_setting('junior.inbox_item_owner_kind', true), '');
    NEW."owner_id" := nullif(current_setting('junior.inbox_item_owner_id', true), '');
    IF NEW."owner_kind" IS NULL OR NEW."owner_id" IS NULL THEN
      RAISE EXCEPTION 'Inbox item % has no owner to write', NEW."id";
    END IF;
    NEW."dedupe_key" := CASE
        WHEN NEW."subject_kind" IN ('automation', 'reply', 'todo') THEN NEW."subject_kind" || ':' || NEW."subject_id"
        WHEN NEW."subject_kind" = 'question' THEN NEW."subject_id"
        ELSE 'plugin:' || NEW."subject_kind" || ':' || NEW."subject_id"
      END;
    NEW."visibility" := CASE
        WHEN NEW."subject_kind" = 'todo' THEN 'private'
        WHEN NEW."owner_kind" = 'automation' THEN (SELECT d."visibility" FROM "junior_automations" a JOIN "junior_destinations" d ON d."provider" = 'slack' AND d."provider_tenant_id" = a."team_id" AND d."provider_destination_id" = a."channel_id" WHERE a."id" = NEW."owner_id")
        ELSE (SELECT CASE WHEN r."visibility" = 'public' THEN d."visibility" END FROM "junior_conversations" o JOIN "junior_conversations" r ON r."conversation_id" = o."root_conversation_id" JOIN "junior_destinations" d ON d."id" = r."destination_id" WHERE o."conversation_id" = NEW."owner_id")
      END;
    IF NEW."visibility" IS DISTINCT FROM 'public' THEN
      NEW."visibility" := 'private';
    END IF;
  END IF;
  IF NEW."subject_kind" = 'question'
    AND (NEW."title" IS NULL OR NEW."body" IS NULL OR (NEW."kind" = 'action' AND NEW."request" IS NULL))
  THEN
    SELECT q."title", q."body", q."request" INTO question FROM "junior_questions" q WHERE q."id" = NEW."subject_id";
    NEW."title" := coalesce(NEW."title", question."title", '');
    NEW."body" := coalesce(NEW."body", question."body", '');
    IF NEW."kind" = 'action' AND NEW."request" IS NULL THEN
      -- The release before this one reads `evidence`, not `related`.
      NEW."request" := CASE
          WHEN question."request" ? 'related' THEN (question."request" - 'related') || jsonb_build_object('evidence', question."request" -> 'related')
          ELSE coalesce(question."request", '{}'::jsonb)
        END;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "junior_inbox_items_legacy_write" BEFORE INSERT OR UPDATE ON "junior_inbox_items" FOR EACH ROW EXECUTE FUNCTION "junior_inbox_items_legacy_write"();--> statement-breakpoint
-- A subject now has one open item in all provider tenants, not one in each.
-- Before the next migration makes that unique, the newest open item of a
-- subject stays open and the others close. Two tenants seldom share a
-- subject, because each subject id names one Conversation, Automation, or
-- plugin object.
-- junior:bounded-backfill: only open items whose subject has a newer open item in another provider tenant change.
UPDATE "junior_inbox_items" AS "item" SET "status" = 'dismissed', "closed_at" = now(), "close_reason" = 'A newer item asks about the same subject.', "updated_at" = now() WHERE "item"."status" = 'open' AND EXISTS (SELECT 1 FROM "junior_inbox_items" AS "newer" WHERE "newer"."status" = 'open' AND "newer"."subject_kind" = "item"."subject_kind" AND "newer"."subject_id" = "item"."subject_id" AND ("newer"."updated_at", "newer"."id") > ("item"."updated_at", "item"."id"));--> statement-breakpoint
-- junior:bounded-backfill: a snooze of a closed duplicate moves to the item that stays open in any provider tenant, as in `20261126153100_inbox_item_subjects`. It reads only the snoozes of the few duplicates.
UPDATE "junior_inbox_snoozes" AS "snooze" SET "inbox_item_id" = "move"."open_id" FROM (SELECT DISTINCT ON ("snooze"."user_id", "open"."id") "snooze"."id", "open"."id" AS "open_id" FROM "junior_inbox_snoozes" AS "snooze" JOIN "junior_inbox_items" AS "item" ON "item"."id" = "snooze"."inbox_item_id" JOIN "junior_inbox_items" AS "open" ON "open"."status" = 'open' AND "open"."subject_kind" = "item"."subject_kind" AND "open"."subject_id" = "item"."subject_id" WHERE "snooze"."state" = 'snoozed' AND "item"."status" = 'dismissed' AND "item"."close_reason" = 'A newer item asks about the same subject.' AND NOT EXISTS (SELECT 1 FROM "junior_inbox_snoozes" AS "kept" WHERE "kept"."inbox_item_id" = "open"."id" AND "kept"."user_id" = "snooze"."user_id" AND "kept"."state" = 'snoozed') ORDER BY "snooze"."user_id", "open"."id", "snooze"."created_at" DESC) AS "move" WHERE "snooze"."id" = "move"."id";--> statement-breakpoint
-- junior:bounded-backfill: the assignees of a closed duplicate join the item that stays open, so they keep their ask. It reads only the assignees of the few duplicates. An open item with no assignees asks everyone, so it gets none.
INSERT INTO "junior_inbox_item_assignees" ("item_id", "user_id") SELECT DISTINCT "open"."id", "assignee"."user_id" FROM "junior_inbox_item_assignees" AS "assignee" JOIN "junior_inbox_items" AS "item" ON "item"."id" = "assignee"."item_id" JOIN "junior_inbox_items" AS "open" ON "open"."status" = 'open' AND "open"."subject_kind" = "item"."subject_kind" AND "open"."subject_id" = "item"."subject_id" WHERE "item"."status" = 'dismissed' AND "item"."close_reason" = 'A newer item asks about the same subject.' AND EXISTS (SELECT 1 FROM "junior_inbox_item_assignees" AS "kept" WHERE "kept"."item_id" = "open"."id") ON CONFLICT DO NOTHING;--> statement-breakpoint
-- junior:bounded-backfill: the sent pushes of a closed duplicate clear, as for any closed item, so the devices close it. It reads only the deliveries of the few duplicates.
UPDATE "junior_inbox_item_deliveries" AS "delivery" SET "status" = 'cleared', "updated_at" = now() FROM "junior_inbox_items" AS "item" WHERE "item"."id" = "delivery"."item_id" AND "delivery"."status" = 'sent' AND "item"."status" = 'dismissed' AND "item"."close_reason" = 'A newer item asks about the same subject.';
