-- 0096 adds the widened kind checks NOT VALID, so that it does not scan the
-- table under lock. Every existing row already passes them.
ALTER TABLE "junior_conversations" VALIDATE CONSTRAINT "junior_conversations_kind_check";--> statement-breakpoint
ALTER TABLE "junior_conversations" VALIDATE CONSTRAINT "junior_conversations_kind_parent_check";
