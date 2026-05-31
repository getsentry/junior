## 1. Source Inventory

- [x] 1.1 Inspect existing credential, security, OAuth, plugin, sandbox, scheduler, and testing specs.
- [x] 1.2 Inspect credential broker contracts, OAuth bearer broker, GitHub App broker, API header broker, token store, header transforms, sandbox egress policy/session/OIDC/proxy code, and handler wiring.
- [x] 1.3 Inventory current unit, integration, and eval coverage for broker issuance, sandbox egress forwarding, requester scoping, placeholder env, and auth-required behavior.

## 2. Prior Art Review

- [x] 2.1 Review Vercel Sandbox firewall and forwarding behavior.
- [x] 2.2 Review Vercel Sandbox authentication modes.
- [x] 2.3 Review OAuth refresh-token and GitHub App installation-token prior art.

## 3. Spec Authoring

- [x] 3.1 Create the `credential-injection` OpenSpec requirements and scenarios.
- [x] 3.2 Record undefined behavior and open questions in the worksheet.
- [x] 3.3 Create the verification map with current test/eval mapping and follow-up gaps.

## 4. Validation

- [x] 4.1 Run `openspec validate backfill-credential-injection`.
- [x] 4.2 Record validation notes and deferred verification.
- [x] 4.3 Mark the baseline tracker item complete after validation passes.
