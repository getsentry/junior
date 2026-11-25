-- New code reads the owner, visibility, and provider tenant of an Inbox item
-- from its subject (`chat/inbox-items/owner.ts`), and writes no value to
-- `owner_kind`, `owner_id`, `visibility`, `provider`, or
-- `provider_tenant_id`. The columns stay for one release, because old
-- workers still write them while this release rolls out. So new rows can
-- leave them empty, and no check reads them.
ALTER TABLE "junior_inbox_items" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_inbox_items" ALTER COLUMN "visibility" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_inbox_items" DROP CONSTRAINT IF EXISTS "junior_inbox_items_owner_check";--> statement-breakpoint
ALTER TABLE "junior_inbox_items" DROP CONSTRAINT IF EXISTS "junior_inbox_items_tenant_check";--> statement-breakpoint
ALTER TABLE "junior_inbox_items" DROP CONSTRAINT IF EXISTS "junior_inbox_items_visibility_check";--> statement-breakpoint
-- A subject now has one open item in all provider tenants, not one in each.
-- Before the next migration makes that unique, the newest open item of a
-- subject stays open and the others close. Two tenants seldom share a
-- subject, because each subject id names one Conversation, Automation, or
-- plugin object.
-- junior:bounded-backfill: only open items whose subject has a newer open item in another provider tenant change.
UPDATE "junior_inbox_items" AS "item" SET "status" = 'dismissed', "closed_at" = now(), "close_reason" = 'A newer item asks about the same subject.', "updated_at" = now() WHERE "item"."status" = 'open' AND EXISTS (SELECT 1 FROM "junior_inbox_items" AS "newer" WHERE "newer"."status" = 'open' AND "newer"."subject_kind" = "item"."subject_kind" AND "newer"."subject_id" = "item"."subject_id" AND ("newer"."updated_at", "newer"."id") > ("item"."updated_at", "item"."id"));
