# Queue Jobs

This module owns the common public queue boundary for background work.

Each job keeps its payload schema, signature context and version, signing parts,
idempotency key, topic, and worker local. The shared code owns the signed wire
fields, verification results, request deadline, retry hook, and local consumer
registration.

Every callback must set `maxDeliveries`. Use a number when the queue callback
owns the limit. Use `null` only when durable job state owns the attempt limit.
