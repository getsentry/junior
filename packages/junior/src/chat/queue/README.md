# Queue

Shared sign/check and Vercel callback wiring for background jobs.

Keep each job's schema, context, version, signed parts, topic, idempotency key,
and worker local. Share only the signed fields, check results, request deadline,
retry hook, and local consumer setup.

Set `maxDeliveries` on every callback. Use a number when the callback owns the
limit. Use `null` when durable state already owns it.
