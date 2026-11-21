ALTER TABLE "junior_review_items" RENAME TO "junior_inbox_items";--> statement-breakpoint
ALTER TABLE "junior_review_item_assignees" RENAME TO "junior_inbox_item_assignees";--> statement-breakpoint
ALTER TABLE "junior_review_item_conversations" RENAME TO "junior_inbox_item_conversations";--> statement-breakpoint
ALTER TABLE "junior_review_item_slack_cards" RENAME TO "junior_inbox_item_slack_cards";--> statement-breakpoint
ALTER TABLE "junior_inbox_snoozes" RENAME COLUMN "review_item_id" TO "inbox_item_id";--> statement-breakpoint
ALTER INDEX "junior_inbox_snoozes_review_item_idx" RENAME TO "junior_inbox_snoozes_inbox_item_idx";--> statement-breakpoint
ALTER TABLE "junior_inbox_snoozes" RENAME CONSTRAINT "junior_inbox_snoozes_review_item_id_junior_review_items_id_fk" TO "junior_inbox_snoozes_inbox_item_id_junior_inbox_items_id_fk";--> statement-breakpoint
ALTER INDEX "junior_review_item_assignees_user_idx" RENAME TO "junior_inbox_item_assignees_user_idx";--> statement-breakpoint
ALTER TABLE "junior_inbox_item_assignees" RENAME CONSTRAINT "junior_review_item_assignees_item_id_junior_review_items_id_fk" TO "junior_inbox_item_assignees_item_id_junior_inbox_items_id_fk";--> statement-breakpoint
ALTER TABLE "junior_inbox_item_assignees" RENAME CONSTRAINT "junior_review_item_assignees_user_id_junior_users_id_fk" TO "junior_inbox_item_assignees_user_id_junior_users_id_fk";--> statement-breakpoint
ALTER TABLE "junior_inbox_item_assignees" RENAME CONSTRAINT "junior_review_item_assignees_item_id_user_id_pk" TO "junior_inbox_item_assignees_item_id_user_id_pk";--> statement-breakpoint
ALTER INDEX "junior_review_item_conversations_conversation_idx" RENAME TO "junior_inbox_item_conversations_conversation_idx";--> statement-breakpoint
ALTER TABLE "junior_inbox_item_conversations" RENAME CONSTRAINT "junior_review_item_conversations_item_id_junior_review_items_id_fk" TO "junior_inbox_item_conversations_item_id_junior_inbox_items_id_fk";--> statement-breakpoint
ALTER TABLE "junior_inbox_item_conversations" RENAME CONSTRAINT "junior_review_item_conversations_conversation_id_junior_conversations_conversation_id_fk" TO "junior_inbox_item_conversations_conversation_id_junior_conversations_conversation_id_fk";--> statement-breakpoint
ALTER TABLE "junior_inbox_item_conversations" RENAME CONSTRAINT "junior_review_item_conversations_item_id_conversation_id_pk" TO "junior_inbox_item_conversations_item_id_conversation_id_pk";--> statement-breakpoint
ALTER TABLE "junior_inbox_item_slack_cards" RENAME CONSTRAINT "junior_review_item_slack_cards_item_id_junior_review_items_id_fk" TO "junior_inbox_item_slack_cards_item_id_junior_inbox_items_id_fk";--> statement-breakpoint
ALTER TABLE "junior_inbox_item_slack_cards" RENAME CONSTRAINT "junior_review_item_slack_cards_conversation_id_junior_conversations_conversation_id_fk" TO "junior_inbox_item_slack_cards_conversation_id_junior_conversations_conversation_id_fk";--> statement-breakpoint
ALTER TABLE "junior_inbox_item_slack_cards" RENAME CONSTRAINT "junior_review_item_slack_cards_item_id_conversation_id_pk" TO "junior_inbox_item_slack_cards_item_id_conversation_id_pk";--> statement-breakpoint
ALTER INDEX "junior_review_items_open_dedupe_uidx" RENAME TO "junior_inbox_items_open_dedupe_uidx";--> statement-breakpoint
ALTER INDEX "junior_review_items_status_idx" RENAME TO "junior_inbox_items_status_idx";--> statement-breakpoint
ALTER INDEX "junior_review_items_subject_idx" RENAME TO "junior_inbox_items_subject_idx";--> statement-breakpoint
ALTER INDEX "junior_review_items_owner_idx" RENAME TO "junior_inbox_items_owner_idx";--> statement-breakpoint
ALTER INDEX "junior_review_items_open_action_owner_idx" RENAME TO "junior_inbox_items_open_action_owner_idx";--> statement-breakpoint
ALTER INDEX "junior_review_items_automation_idx" RENAME TO "junior_inbox_items_automation_idx";--> statement-breakpoint
ALTER INDEX "junior_review_items_answered_idx" RENAME TO "junior_inbox_items_answered_idx";--> statement-breakpoint
ALTER TABLE "junior_inbox_items" RENAME CONSTRAINT "junior_review_items_kind_check" TO "junior_inbox_items_kind_check";--> statement-breakpoint
ALTER TABLE "junior_inbox_items" RENAME CONSTRAINT "junior_review_items_owner_check" TO "junior_inbox_items_owner_check";--> statement-breakpoint
ALTER TABLE "junior_inbox_items" RENAME CONSTRAINT "junior_review_items_status_check" TO "junior_inbox_items_status_check";--> statement-breakpoint
ALTER TABLE "junior_inbox_items" RENAME CONSTRAINT "junior_review_items_tenant_check" TO "junior_inbox_items_tenant_check";--> statement-breakpoint
ALTER TABLE "junior_inbox_items" RENAME CONSTRAINT "junior_review_items_visibility_check" TO "junior_inbox_items_visibility_check";--> statement-breakpoint
ALTER TABLE "junior_inbox_items" RENAME CONSTRAINT "junior_review_items_automation_id_junior_automations_id_fk" TO "junior_inbox_items_automation_id_junior_automations_id_fk";--> statement-breakpoint
ALTER TABLE "junior_inbox_items" RENAME CONSTRAINT "junior_review_items_closed_by_user_id_junior_users_id_fk" TO "junior_inbox_items_closed_by_user_id_junior_users_id_fk";
