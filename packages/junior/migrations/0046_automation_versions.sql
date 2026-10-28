CREATE TABLE "junior_automation_versions" (
	"kind" text NOT NULL,
	"automation_id" text NOT NULL,
	"version" integer NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"edited_by" jsonb,
	"definition" jsonb NOT NULL,
	CONSTRAINT "junior_automation_versions_pk" PRIMARY KEY("kind","automation_id","version"),
	CONSTRAINT "junior_automation_versions_kind_check" CHECK ("junior_automation_versions"."kind" in ('scheduled', 'event'))
);
--> statement-breakpoint
-- Save the current definition of each live Automation as version 1.
-- The editor is unknown and the time is the upgrade time.
-- Older workers can still write thread destinations, so remove threadTs.
INSERT INTO "junior_automation_versions" ("kind", "automation_id", "version", "created_at_ms", "edited_by", "definition")
SELECT
	'scheduled',
	"id",
	1,
	(extract(epoch from now()) * 1000)::bigint,
	NULL,
	jsonb_build_object(
		'title', nullif(btrim("title"), ''),
		'instruction', "record"->'task'->>'text',
		'credentialMode', "record"->>'credentialMode',
		'destination', ("record"->'destination') - 'threadTs',
		'outcomes', coalesce(
			(
				SELECT jsonb_agg(
					jsonb_set("outcome", '{destination}', ("outcome"->'destination') - 'threadTs', false)
					ORDER BY "ordinality"
				)
				FROM jsonb_array_elements("record"->'outcomes') WITH ORDINALITY AS "items"("outcome", "ordinality")
			),
			'[]'::jsonb
		),
		'schedule', "record"->'schedule'
	)
FROM "junior_scheduler_tasks"
WHERE "status" <> 'deleted'
	AND "record"->'task' ? 'text'
	AND "record" ?& array['credentialMode', 'destination', 'outcomes', 'schedule'];
--> statement-breakpoint
INSERT INTO "junior_automation_versions" ("kind", "automation_id", "version", "created_at_ms", "edited_by", "definition")
SELECT
	'event',
	"id",
	1,
	(extract(epoch from now()) * 1000)::bigint,
	NULL,
	jsonb_build_object(
		'title', nullif(btrim("title"), ''),
		'instruction', "task_json"->'task'->>'text',
		'credentialMode', "task_json"->>'credentialMode',
		'destination', ("task_json"->'destination') - 'threadTs',
		'outcomes', coalesce(
			(
				SELECT jsonb_agg(
					jsonb_set("outcome", '{destination}', ("outcome"->'destination') - 'threadTs', false)
					ORDER BY "ordinality"
				)
				FROM jsonb_array_elements("task_json"->'outcomes') WITH ORDINALITY AS "items"("outcome", "ordinality")
			),
			'[]'::jsonb
		),
		'trigger', "task_json"->'trigger'
	)
FROM "junior_event_tasks"
WHERE "status" <> 'deleted'
	AND "task_json"->'task' ? 'text'
	AND "task_json" ?& array['credentialMode', 'destination', 'outcomes', 'trigger'];
