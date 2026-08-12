CREATE TABLE "junior_conversation_participants" (
	"user_id" text NOT NULL,
	"root_conversation_id" text NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_conversation_participants_user_root_pk" PRIMARY KEY("user_id","root_conversation_id")
);
--> statement-breakpoint
ALTER TABLE "junior_conversation_events" ADD COLUMN "actor_identity_id" text;--> statement-breakpoint
ALTER TABLE "junior_conversation_participants" ADD CONSTRAINT "junior_conversation_participants_user_id_junior_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."junior_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_conversation_participants" ADD CONSTRAINT "junior_conversation_participants_root_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("root_conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_conversation_participants_user_activity_idx" ON "junior_conversation_participants" USING btree ("user_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "junior_conversation_participants_root_idx" ON "junior_conversation_participants" USING btree ("root_conversation_id");--> statement-breakpoint
ALTER TABLE "junior_conversation_events" ADD CONSTRAINT "junior_conversation_events_actor_identity_id_junior_identities_id_fk" FOREIGN KEY ("actor_identity_id") REFERENCES "public"."junior_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_conversation_events_actor_identity_idx" ON "junior_conversation_events" USING btree ("actor_identity_id","conversation_id","seq");--> statement-breakpoint
-- Lift explicit payload authorIdentityId values onto the new column when valid.
UPDATE "junior_conversation_events" AS e
SET "actor_identity_id" = e."payload"->>'authorIdentityId'
WHERE e."actor_identity_id" IS NULL
  AND e."type" IN ('message', 'message_updated')
  AND jsonb_typeof(e."payload") = 'object'
  AND e."payload" ? 'authorIdentityId'
  AND EXISTS (
    SELECT 1
    FROM "junior_identities" AS i
    WHERE i."id" = e."payload"->>'authorIdentityId'
  );--> statement-breakpoint
-- Match durable Slack human authors to known identities by subject (+ tenant when known).
UPDATE "junior_conversation_events" AS e
SET "actor_identity_id" = matched."id"
FROM (
  SELECT DISTINCT ON (e2."conversation_id", e2."seq")
    e2."conversation_id",
    e2."seq",
    i."id"
  FROM "junior_conversation_events" AS e2
  INNER JOIN "junior_conversations" AS c
    ON c."conversation_id" = e2."conversation_id"
  LEFT JOIN "junior_destinations" AS d
    ON d."id" = c."destination_id"
  INNER JOIN "junior_identities" AS i
    ON i."provider" = 'slack'
    AND i."provider_subject_id" = e2."payload"->'meta'->'author'->>'userId'
    AND (
      d."provider_tenant_id" IS NULL
      OR d."provider_tenant_id" = ''
      OR i."provider_tenant_id" = d."provider_tenant_id"
    )
  WHERE e2."actor_identity_id" IS NULL
    AND e2."type" IN ('message', 'message_updated')
    AND e2."payload"->>'role' = 'user'
    AND coalesce((e2."payload"->'meta'->'author'->>'isBot')::boolean, false) = false
    AND coalesce(e2."payload"->'meta'->'author'->>'userId', '') <> ''
  ORDER BY e2."conversation_id", e2."seq", i."updated_at" DESC, i."id"
) AS matched
WHERE e."conversation_id" = matched."conversation_id"
  AND e."seq" = matched."seq"
  AND e."actor_identity_id" IS NULL;--> statement-breakpoint
-- Match durable junior/web human authors by verified email subject, including
-- dashboard:<sha256(email).slice(0,24)> author ids produced by webActorFromEmail.
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
UPDATE "junior_conversation_events" AS e
SET "actor_identity_id" = matched."id"
FROM (
  SELECT DISTINCT ON (e2."conversation_id", e2."seq")
    e2."conversation_id",
    e2."seq",
    i."id"
  FROM "junior_conversation_events" AS e2
  INNER JOIN "junior_identities" AS i
    ON i."provider" = 'junior'
    AND i."kind" = 'user'
    AND i."email_verified" = true
    AND i."email_normalized" IS NOT NULL
    AND (
      i."email_normalized" = lower(e2."payload"->'meta'->'author'->>'email')
      OR i."provider_subject_id" = lower(e2."payload"->'meta'->'author'->>'email')
      OR (
        e2."payload"->'meta'->'author'->>'userId' LIKE 'dashboard:%'
        AND e2."payload"->'meta'->'author'->>'userId' = concat(
          'dashboard:',
          left(encode(digest(i."email_normalized", 'sha256'), 'hex'), 24)
        )
      )
    )
  WHERE e2."actor_identity_id" IS NULL
    AND e2."type" IN ('message', 'message_updated')
    AND e2."payload"->>'role' = 'user'
    AND coalesce((e2."payload"->'meta'->'author'->>'isBot')::boolean, false) = false
  ORDER BY e2."conversation_id", e2."seq", i."updated_at" DESC, i."id"
) AS matched
WHERE e."conversation_id" = matched."conversation_id"
  AND e."seq" = matched."seq"
  AND e."actor_identity_id" IS NULL;--> statement-breakpoint
-- Materialize linked-user participants from authored human user messages.
INSERT INTO "junior_conversation_participants" (
  "user_id",
  "root_conversation_id",
  "last_message_at"
)
SELECT
  i."user_id",
  coalesce(c."root_conversation_id", c."conversation_id") AS "root_conversation_id",
  max(e."created_at") AS "last_message_at"
FROM "junior_conversation_events" AS e
INNER JOIN "junior_identities" AS i
  ON i."id" = e."actor_identity_id"
INNER JOIN "junior_conversations" AS c
  ON c."conversation_id" = e."conversation_id"
WHERE i."user_id" IS NOT NULL
  AND e."type" IN ('message', 'message_updated')
  AND e."payload"->>'role' = 'user'
  AND coalesce((e."payload"->'meta'->'author'->>'isBot')::boolean, false) = false
  AND coalesce(c."root_conversation_id", c."conversation_id") IS NOT NULL
GROUP BY i."user_id", coalesce(c."root_conversation_id", c."conversation_id")
ON CONFLICT ("user_id", "root_conversation_id") DO UPDATE
SET "last_message_at" = greatest(
  "junior_conversation_participants"."last_message_at",
  excluded."last_message_at"
);--> statement-breakpoint
-- Keep root actors in the personal feed even before they author a message row.
INSERT INTO "junior_conversation_participants" (
  "user_id",
  "root_conversation_id",
  "last_message_at"
)
SELECT
  i."user_id",
  c."conversation_id",
  c."last_activity_at"
FROM "junior_conversations" AS c
INNER JOIN "junior_identities" AS i
  ON i."id" = c."actor_identity_id"
WHERE c."parent_conversation_id" IS NULL
  AND i."user_id" IS NOT NULL
  AND i."kind" = 'user'
ON CONFLICT ("user_id", "root_conversation_id") DO UPDATE
SET "last_message_at" = greatest(
  "junior_conversation_participants"."last_message_at",
  excluded."last_message_at"
);
