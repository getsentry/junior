-- Create the one system Identity with the fixed id `system`. Code writes this
-- id without a read, and Message and Conversation rows reference it through
-- foreign keys, so the row must exist. ON CONFLICT DO NOTHING makes a second
-- run do nothing.
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
ON CONFLICT DO NOTHING;
