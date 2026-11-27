-- The next migration lets one opener row, a row with a Conversation, have
-- each pull request id, because core reads the owner Conversation of a pull
-- request's Inbox items from that row. The create keeps one opener row per
-- pull request, so two such rows are rare. When two rows have one id, the
-- oldest row keeps it, and the other rows lose it. They keep their
-- Conversation and requester, so a webhook still finds the opener by
-- repository and number.
-- junior:bounded-backfill: only opener rows whose pull request id an older opener row also has change.
UPDATE "junior_github_pull_request_requesters" AS "requester" SET "pull_request_id" = NULL, "updated_at" = now() WHERE "requester"."conversation_id" IS NOT NULL AND "requester"."pull_request_id" IS NOT NULL AND EXISTS (SELECT 1 FROM "junior_github_pull_request_requesters" AS "older" WHERE "older"."conversation_id" IS NOT NULL AND "older"."pull_request_id" = "requester"."pull_request_id" AND ("older"."created_at", "older"."repository_full_name", "older"."number", "older"."identity_id") < ("requester"."created_at", "requester"."repository_full_name", "requester"."number", "requester"."identity_id"));
