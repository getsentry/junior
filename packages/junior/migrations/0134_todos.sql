ALTER SEQUENCE "public"."junior_plan_item_version_seq" RENAME TO "junior_todo_version_seq";--> statement-breakpoint
ALTER TABLE "junior_plan_items" RENAME TO "junior_todos";--> statement-breakpoint
DROP INDEX "junior_plan_items_in_progress_uidx";--> statement-breakpoint
ALTER TABLE "junior_todos" DROP CONSTRAINT "junior_plan_items_status_check";--> statement-breakpoint
-- junior:bounded-backfill: Each Conversation has only a few To-dos.
UPDATE "junior_todos" SET "status" = CASE "status" WHEN 'done' THEN 'done' WHEN 'cancelled' THEN 'dropped' ELSE 'open' END;--> statement-breakpoint
-- The update above maps every existing row. NOT VALID skips the scan under
-- lock and still checks every new write.
ALTER TABLE "junior_todos" ADD CONSTRAINT "junior_todos_status_check" CHECK ("junior_todos"."status" in ('open', 'done', 'dropped')) NOT VALID;--> statement-breakpoint
ALTER TABLE "junior_todos" RENAME CONSTRAINT "junior_plan_items_assignee_check" TO "junior_todos_assignee_check";--> statement-breakpoint
ALTER TABLE "junior_todos" RENAME CONSTRAINT "junior_plan_items_pk" TO "junior_todos_pk";--> statement-breakpoint
ALTER TABLE "junior_todos" RENAME CONSTRAINT "junior_plan_items_assignee_user_id_junior_users_id_fk" TO "junior_todos_assignee_user_id_junior_users_id_fk";--> statement-breakpoint
ALTER TABLE "junior_todos" RENAME CONSTRAINT "junior_plan_items_changed_by_user_id_junior_users_id_fk" TO "junior_todos_changed_by_user_id_junior_users_id_fk";--> statement-breakpoint
ALTER TABLE "junior_todos" RENAME CONSTRAINT "junior_plan_items_conversation_id_fk" TO "junior_todos_conversation_id_fk";
