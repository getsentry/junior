UPDATE "junior_event_tasks"
SET "task_json" = jsonb_set(
	"task_json",
	'{destination}',
	("task_json"->'destination') - 'threadTs',
	false
)
WHERE "task_json"->'destination' ? 'threadTs';
--> statement-breakpoint
UPDATE "junior_event_tasks"
SET "task_json" = jsonb_set(
	"task_json",
	'{outcomes}',
	(
		SELECT jsonb_agg(
			CASE
				WHEN "outcome"->'destination' ? 'threadTs'
				THEN jsonb_set(
					"outcome",
					'{destination}',
					("outcome"->'destination') - 'threadTs',
					false
				)
				ELSE "outcome"
			END
			ORDER BY "ordinality"
		)
		FROM jsonb_array_elements("task_json"->'outcomes') WITH ORDINALITY AS "items"("outcome", "ordinality")
	),
	false
)
WHERE EXISTS (
	SELECT 1
	FROM jsonb_array_elements("task_json"->'outcomes') AS "items"("outcome")
	WHERE "outcome"->'destination' ? 'threadTs'
);
