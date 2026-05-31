## Why

`specs/security-policy.md` contains cross-cutting security rules that affect sandbox execution, credential issuance, OAuth link delivery, provider auth, and observability. Those rules are already implemented and tested in multiple runtime seams, but they are not expressed as OpenSpec capability requirements with scenarios. Backfilling this capability prevents future changes from treating security posture as optional prose or duplicating provider-specific rules across specs.

## What Changes

- Add a `security-policy` OpenSpec capability baseline for global security invariants.
- Keep detailed mechanics owned by existing capability specs such as `credential-injection`, `oauth-flows`, `plugin-auth`, `sandbox-tools`, `slack-agent-delivery`, and observability specs.
- Record local implementation evidence, prior art, undefined security exception behavior, and verification coverage.
- Do not change runtime code or existing canonical policy prose in this change.

## Capabilities

### New Capabilities

- `security-policy`: Defines Junior's global runtime security invariants for secret custody, sandbox isolation, requester-bound credential issuance, private authorization delivery, logging redaction, and incident response.

### Modified Capabilities

- None.

## Impact

- Adds OpenSpec artifacts under `openspec/changes/backfill-security-policy/`.
- Creates a verification map for existing security-sensitive unit and integration coverage.
- Defers implementation gaps and exception-process decisions as open questions.
