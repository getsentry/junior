ALTER TABLE "junior_conversation_annotations" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "junior_conversation_annotations" ADD COLUMN "url" text;--> statement-breakpoint
-- New code writes no link in the JSON, so the subject of an object without
-- a provider id comes from the `url` column. An old worker's row still has
-- the link only in its JSON.
CREATE OR REPLACE FUNCTION "junior_conversation_annotations_legacy_subject"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  object_type text := NEW."annotation_json"->>'objectType';
  url text := coalesce(NEW."url", NEW."annotation_json"->>'url');
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
    NEW."action" := CASE
        WHEN NEW."kind" = 'resource_link' AND NEW."annotation_json"->>'status' IS NULL THEN 'attached'
        ELSE 'changed'
      END;
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
-- An Annotation stores the title and the link of its object in columns,
-- and no other fact of it: a card reads the object live. Old workers still
-- write the title, the link, and the other facts in the JSON while this
-- release rolls out, so a trigger moves the title and the link to their
-- columns and drops the rest. A link that a person attached keeps no title.
-- Triggers run in name order, so this one runs after
-- `junior_conversation_annotations_legacy_subject`, which reads the old
-- JSON. The backfill below fires it for every saved Annotation.
CREATE OR REPLACE FUNCTION "junior_conversation_annotations_stored_fields"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."kind" = 'object' THEN
    NEW."title" := coalesce(NEW."annotation_json"->>'title', NEW."title");
  END IF;
  NEW."url" := coalesce(NEW."annotation_json"->>'url', NEW."url");
  NEW."annotation_json" := NEW."annotation_json" - ARRAY[
    'title', 'url', 'label', 'status', 'description', 'facts',
    'sourceUpdatedAt', 'warning', 'trigger', 'displayType'
  ];
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "junior_conversation_annotations_stored_fields" BEFORE INSERT OR UPDATE ON "junior_conversation_annotations" FOR EACH ROW WHEN (NEW."annotation_json" ?| ARRAY['title', 'url', 'label', 'status', 'description', 'facts', 'sourceUpdatedAt', 'warning', 'trigger', 'displayType']) EXECUTE FUNCTION "junior_conversation_annotations_stored_fields"();--> statement-breakpoint
-- junior:bounded-backfill: every saved Annotation needs its title and link in the columns before search and cards read them, so the update runs once over the Annotation table. Each Conversation has only the few objects that it created, changed, or attached, and the update writes each row once.
UPDATE "junior_conversation_annotations" SET "annotation_json" = "annotation_json" WHERE "annotation_json" ?| ARRAY['title', 'url', 'label', 'status', 'description', 'facts', 'sourceUpdatedAt', 'warning', 'trigger', 'displayType'];
