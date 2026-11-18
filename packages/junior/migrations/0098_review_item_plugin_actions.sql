ALTER TABLE "junior_review_items" DROP CONSTRAINT "junior_review_items_kind_check";--> statement-breakpoint
-- The new check only allows more rows than the old one, so every row passes.
-- NOT VALID skips the scan under lock and still checks every new write. A
-- later migration validates it.
ALTER TABLE "junior_review_items" ADD CONSTRAINT "junior_review_items_kind_check" CHECK (("junior_review_items"."kind" = 'notice' and "junior_review_items"."request" is null and "junior_review_items"."answer" is null) or ("junior_review_items"."kind" = 'action' and ("junior_review_items"."request" is not null or ("junior_review_items"."dedupe_key" like 'plugin:%' and "junior_review_items"."answer" is null)))) NOT VALID;
