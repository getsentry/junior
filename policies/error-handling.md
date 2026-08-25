# Error Handling

## Intent

Unexpected failures should fail at the owning runtime edge so top-level
exception handling, tracing, and retries can report one clear error. Local
catch-and-log blocks make important failures look recoverable and create noisy
duplicate diagnostics.

## Policy

- Let operations that should succeed throw to the caller. Do not catch only to
  log a warning and continue.
- Catch errors only when the current layer can recover, translate an expected
  edge failure into a typed domain result, or add required cleanup that cannot
  be expressed with `finally`.
- If a catch block handles an error, it must either finish the recovery or
  rethrow with useful domain context. Avoid log-and-rethrow duplicates.
- Do not change which errors a catch handles during a refactor. A catch for an
  agent Run must not also handle later save, delivery, or Turn event errors.
  Those operations can have different retry rules.
- When adjacent async steps need different error handling, keep them in separate
  `try` blocks or use a small typed error. Add one focused test that proves each
  error reaches the correct handler.
- Use `finally` for cleanup that must run without changing error ownership.
- Keep best-effort observers explicit. If correctness depends on the operation,
  it is not best-effort.

## Exceptions

- External systems with expected transient failures may catch at the edge that
  owns retry, backoff, auth pause, or typed fallback behavior.
- Product surfaces that intentionally degrade, such as optional UI streaming or
  non-critical observer callbacks, may catch locally when dropping the failure is
  part of their contract.
