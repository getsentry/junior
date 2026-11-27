ALTER TABLE "junior_conversation_annotations" ADD COLUMN "subject_kind" text;--> statement-breakpoint
ALTER TABLE "junior_conversation_annotations" ADD COLUMN "subject_id" text;--> statement-breakpoint
ALTER TABLE "junior_conversation_annotations" ADD COLUMN "action" text;--> statement-breakpoint
-- Each Annotation names its object by a subject, as an Inbox item does, and
-- says what the Conversation did to it. New code writes both. Old workers
-- still write rows without them while this release rolls out, and new code
-- writes none for an object whose provider id it does not know, so a
-- trigger fills them from the saved JSON. The backfill below fires the same
-- trigger.
--
-- The subject of a saved object, by its plugin and type:
-- - An Automation card of core (`junior`) is the core `automation` kind,
--   with the Automation id.
-- - A GitHub pull request is `github:pull_request`, with GitHub's id of it,
--   read from the code change records by the repository and number in the
--   key. A GitHub issue is `github:issue`, with the `objectId` that new
--   issue cards saved.
-- - A Calendar event, a Vercel deployment, and a Linear Ticket keep their
--   key, which is the provider id (a Ticket's is its identifier).
-- - Any other object, such as an attached link or a GitHub object whose id
--   is not known, is the core `link` kind, with its link.
-- Every saved object was changed: the old JSON does not say which
-- Conversation created it.
CREATE OR REPLACE FUNCTION "junior_conversation_annotations_legacy_subject"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  object_type text := NEW."annotation_json"->>'objectType';
  url text := NEW."annotation_json"->>'url';
  github_ref text := CASE
      WHEN NEW."plugin" = 'github' AND NEW."key" ~ '^[^#]+#[0-9]+$' THEN NEW."key"
    END;
  github_pull_request boolean := github_ref IS NOT NULL AND (
      object_type = 'code_change'
      OR (object_type IS NULL AND url ~ '^https://github\.com/[^/]+/[^/]+/pull/[0-9]+')
    );
  kind text;
  id text;
BEGIN
  IF NEW."plugin" = 'junior' AND object_type = 'automation' THEN
    kind := 'automation';
    id := NEW."key";
  ELSIF github_pull_request THEN
    SELECT c."provider_id" INTO id
    FROM "junior_code_changes" c
    JOIN "junior_code_repositories" r ON r."id" = c."repository_id"
    WHERE c."provider" = 'github'
      AND lower(r."name") = lower(split_part(github_ref, '#', 1))
      AND c."number" = split_part(github_ref, '#', 2)::integer
    LIMIT 1;
    kind := CASE WHEN id IS NOT NULL THEN 'github:pull_request' END;
  ELSIF github_ref IS NOT NULL THEN
    id := NEW."annotation_json"->>'objectId';
    kind := CASE WHEN id IS NOT NULL THEN 'github:issue' END;
  ELSIF NEW."plugin" = 'google' AND object_type = 'calendar_event' THEN
    kind := 'google:calendar_event';
    id := NEW."key";
  ELSIF NEW."plugin" = 'vercel' AND object_type = 'deployment' THEN
    kind := 'vercel:deployment';
    id := NEW."key";
  ELSIF NEW."plugin" = 'linear' AND object_type = 'task' THEN
    kind := 'linear:issue';
    id := NEW."key";
  END IF;
  IF NEW."subject_kind" IS NULL THEN
    NEW."subject_kind" := coalesce(kind, 'link');
    NEW."subject_id" := CASE WHEN kind IS NOT NULL THEN id ELSE coalesce(url, NEW."key") END;
  END IF;
  IF NEW."action" IS NULL THEN
    NEW."action" := 'changed';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "junior_conversation_annotations_legacy_subject" BEFORE INSERT OR UPDATE ON "junior_conversation_annotations" FOR EACH ROW WHEN (NEW."subject_kind" IS NULL OR NEW."action" IS NULL) EXECUTE FUNCTION "junior_conversation_annotations_legacy_subject"();--> statement-breakpoint
-- junior:bounded-backfill: every saved Annotation needs its subject before search and the new primary key use it, so the update runs once over the Annotation table. Each Conversation has only the few objects that it created or changed, and the update writes each row once.
UPDATE "junior_conversation_annotations" SET "subject_kind" = NULL;
