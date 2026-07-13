UPDATE "junior_scheduler_tasks"
SET "record" = ("record" - 'credentialSubject') || jsonb_build_object('credentialMode', 'system')
WHERE NOT ("record" ? 'credentialMode')
   OR "record" ? 'credentialSubject';
