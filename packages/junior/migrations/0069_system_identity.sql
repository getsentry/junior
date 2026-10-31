-- Create the one system Identity with the fixed id `system`. Code uses this id
-- without a read, so the row must exist before new workers start. Released
-- versions never saved this key, so no row can have it under another id.
-- ON CONFLICT DO NOTHING makes a second run do nothing.
INSERT INTO "junior_identities" (
	"id",
	"kind",
	"provider",
	"provider_tenant_id",
	"provider_subject_id",
	"display_name",
	"created_at",
	"updated_at"
)
VALUES (
	'system',
	'system',
	'junior',
	'',
	'system',
	'System',
	CURRENT_TIMESTAMP,
	CURRENT_TIMESTAMP
)
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Stop the upgrade if an unreleased build saved the system key under a random
-- id. Rows can point to that id, so this migration does not change it.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM "junior_identities"
		WHERE "id" = 'system'
			AND "provider" = 'junior'
			AND "provider_tenant_id" = ''
			AND "provider_subject_id" = 'system'
	) THEN
		RAISE EXCEPTION 'The system Identity key exists under an id other than system';
	END IF;
END $$;
