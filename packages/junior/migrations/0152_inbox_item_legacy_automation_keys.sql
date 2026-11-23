-- Before 0139 reserved the `automation:` dedupe key prefix for Automation
-- alerts, agents used it for their own items, such as
-- `automation:<id>:rewrite` for a question about an Automation. 0139 added
-- the owner check as NOT VALID because it assumed that no such row existed.
-- These rows are Conversation items with an `automation:` key, so they break
-- the check, and each update to them fails: a person cannot dismiss, answer,
-- or take them. The runtime also reads the prefix as an Automation alert, so
-- an answer goes to core and not to the agent that asked.
-- The new key holds the item id, which is unique, so it matches no other
-- open item. Since 0139, agents cannot use the old keys, so no add looks for
-- them.
-- junior:bounded-backfill: only Conversation items that agents added with an `automation:` key before 0139 reserved the prefix, about a dozen rows.
UPDATE "junior_inbox_items"
SET
  "dedupe_key" = 'ask:' || "id",
  "updated_at" = now()
WHERE "owner_kind" = 'conversation'
  AND "dedupe_key" LIKE 'automation:%';--> statement-breakpoint
-- Now every row meets the check. VALIDATE proves it, so no row that breaks
-- the check stays until a person's click finds it.
ALTER TABLE "junior_inbox_items" VALIDATE CONSTRAINT "junior_inbox_items_owner_check";
