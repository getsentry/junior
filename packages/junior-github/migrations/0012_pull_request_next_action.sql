-- `ready_to_merge_at` stays for one release, so workers from before this
-- migration keep working during the rollout. A later migration drops it.
-- `next_action` starts empty: the next check of each pull request derives
-- its action and moves an open item from the old keys to the new one.
ALTER TABLE "junior_github_pull_requests" ADD COLUMN "next_action" text;
