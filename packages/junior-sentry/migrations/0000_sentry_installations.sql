CREATE TABLE "junior_sentry_installations" (
	"installation_uuid" text PRIMARY KEY NOT NULL,
	"org_slug" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "junior_sentry_installations_org_slug_unique" UNIQUE("org_slug")
);
