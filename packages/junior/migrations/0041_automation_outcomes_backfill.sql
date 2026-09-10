UPDATE "junior_scheduler_tasks"
SET "record" = jsonb_set(
	"record",
	'{outcomes}',
	jsonb_build_array(
		jsonb_build_object(
			'action', 'send_message',
			'destination', "record"->'destination'
		)
	),
	true
)
WHERE NOT "record" ? 'outcomes';
--> statement-breakpoint
UPDATE "junior_event_tasks"
SET "task_json" = jsonb_set(
	"task_json",
	'{outcomes}',
	jsonb_build_array(
		jsonb_build_object(
			'action', 'send_message',
			'destination', "task_json"->'destination'
		)
	),
	true
)
WHERE NOT "task_json" ? 'outcomes';
