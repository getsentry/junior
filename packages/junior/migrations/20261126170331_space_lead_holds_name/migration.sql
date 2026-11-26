-- A Space's name, visibility, and archive are now its Lead's title,
-- visibility, and archive time. The snapshot no longer has
-- junior_spaces.name, visibility, and archived_at, or junior_space_members.
-- They stay in the database for one release, because 0.316.0 still reads
-- and writes them while this migration runs. The next release drops them
-- with DROP ... IF EXISTS.

-- New Spaces store no name. 0.316.0 still writes one.
ALTER TABLE "junior_spaces" ALTER COLUMN "name" SET DEFAULT '';--> statement-breakpoint

-- The Space's name wins where a Lead's title differs from it.
-- junior:bounded-backfill: runs once, on the one Lead of each Space. Spaces are new and few.
UPDATE "junior_conversations" AS "lead"
SET "title" = "space"."name", "detail_version" = "lead"."detail_version" + 1
FROM "junior_spaces" AS "space"
WHERE "lead"."kind" = 'lead'
  AND "lead"."space_id" = "space"."id"
  AND "lead"."title" IS DISTINCT FROM "space"."name";--> statement-breakpoint

-- An archived Space archives its Lead's tree with one time, as a core
-- archive with applyToChildren does, so a restore brings it all back.
-- Rows that are already archived keep their own time.
-- junior:bounded-backfill: runs once, on the work of the few archived Spaces. Spaces are new and small.
UPDATE "junior_conversations" AS "work"
SET "archived_at" = "space"."archived_at", "detail_version" = "work"."detail_version" + 1
FROM "junior_conversations" AS "lead", "junior_spaces" AS "space"
WHERE "lead"."kind" = 'lead'
  AND "lead"."space_id" = "space"."id"
  AND "space"."archived_at" IS NOT NULL
  AND ("work"."conversation_id" = "lead"."conversation_id"
    OR "work"."root_conversation_id" = "lead"."conversation_id")
  AND "work"."archived_at" IS NULL;--> statement-breakpoint

-- A private Space keeps its work private. Every row of a tree has its
-- root's visibility, so the whole tree of its Lead changes. This never
-- makes private work public.
-- junior:bounded-backfill: runs once, on the work of the few private Spaces. Spaces are new and small.
UPDATE "junior_conversations" AS "work"
SET "visibility" = 'private', "detail_version" = "work"."detail_version" + 1
FROM "junior_conversations" AS "lead", "junior_spaces" AS "space"
WHERE "lead"."kind" = 'lead'
  AND "lead"."space_id" = "space"."id"
  AND "space"."visibility" = 'private'
  AND "work"."root_conversation_id" = "lead"."conversation_id"
  AND "work"."visibility" IS DISTINCT FROM 'private';
