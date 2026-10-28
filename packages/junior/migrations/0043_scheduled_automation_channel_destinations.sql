UPDATE "junior_scheduler_tasks"
SET "record" = jsonb_set(
	"record",
	'{destination}',
	("record"->'destination') - 'threadTs',
	false
)
WHERE "record"->'destination' ? 'threadTs';
--> statement-breakpoint
UPDATE "junior_scheduler_tasks"
SET "record" = jsonb_set(
	"record",
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
		FROM jsonb_array_elements("record"->'outcomes') WITH ORDINALITY AS "items"("outcome", "ordinality")
	),
	false
)
WHERE EXISTS (
	SELECT 1
	FROM jsonb_array_elements("record"->'outcomes') AS "items"("outcome")
	WHERE "outcome"->'destination' ? 'threadTs'
);
