-- Wake the dashboard versions streams after a write to a table that a
-- `GET /api/versions` token reads. The payload is empty, so Postgres folds
-- the notifications of one transaction into one, and a statement trigger
-- sends one per statement, not one per row. Postgres delivers a NOTIFY at
-- commit and drops it on rollback, so a read after it sees the write.
CREATE OR REPLACE FUNCTION "junior_notify_versions"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
	PERFORM pg_notify('junior_versions', '');
	RETURN NULL;
END
$function$;--> statement-breakpoint
CREATE TRIGGER "junior_notify_versions" AFTER INSERT OR UPDATE OR DELETE ON "junior_conversations" FOR EACH STATEMENT EXECUTE FUNCTION "junior_notify_versions"();--> statement-breakpoint
CREATE TRIGGER "junior_notify_versions" AFTER INSERT OR UPDATE OR DELETE ON "junior_conversation_participants" FOR EACH STATEMENT EXECUTE FUNCTION "junior_notify_versions"();--> statement-breakpoint
CREATE TRIGGER "junior_notify_versions" AFTER INSERT OR UPDATE OR DELETE ON "junior_conversation_annotations" FOR EACH STATEMENT EXECUTE FUNCTION "junior_notify_versions"();--> statement-breakpoint
CREATE TRIGGER "junior_notify_versions" AFTER INSERT OR UPDATE OR DELETE ON "junior_inbox_items" FOR EACH STATEMENT EXECUTE FUNCTION "junior_notify_versions"();--> statement-breakpoint
CREATE TRIGGER "junior_notify_versions" AFTER INSERT OR UPDATE OR DELETE ON "junior_conversation_metrics" FOR EACH STATEMENT EXECUTE FUNCTION "junior_notify_versions"();--> statement-breakpoint
CREATE TRIGGER "junior_notify_versions" AFTER INSERT OR UPDATE OR DELETE ON "junior_attachments" FOR EACH STATEMENT EXECUTE FUNCTION "junior_notify_versions"();--> statement-breakpoint
CREATE TRIGGER "junior_notify_versions" AFTER INSERT OR UPDATE OR DELETE ON "junior_identities" FOR EACH STATEMENT EXECUTE FUNCTION "junior_notify_versions"();--> statement-breakpoint
CREATE TRIGGER "junior_notify_versions" AFTER INSERT OR UPDATE OR DELETE ON "junior_users" FOR EACH STATEMENT EXECUTE FUNCTION "junior_notify_versions"();--> statement-breakpoint
CREATE TRIGGER "junior_notify_versions" AFTER INSERT OR UPDATE OR DELETE ON "junior_destinations" FOR EACH STATEMENT EXECUTE FUNCTION "junior_notify_versions"();--> statement-breakpoint
CREATE TRIGGER "junior_notify_versions" AFTER INSERT OR UPDATE OR DELETE ON "junior_inbox_snoozes" FOR EACH STATEMENT EXECUTE FUNCTION "junior_notify_versions"();--> statement-breakpoint
-- The feed token counts live authorization requests, which are events. Most
-- event writes move no token, so only this event type notifies.
CREATE TRIGGER "junior_notify_versions" AFTER INSERT ON "junior_conversation_events" FOR EACH ROW WHEN (NEW."type" = 'authorization_requested') EXECUTE FUNCTION "junior_notify_versions"();
