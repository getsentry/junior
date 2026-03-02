# Sandbox Runtime Guidance

This skill runs in the harness sandbox (`node22`) and scripts execute via the `bash` tool.

## What is currently available

- Node runtime in sandbox (`node22` image).
- Writable workspace under `/vercel/sandbox`.
- Outbound network access (default allow-all unless harness sets a network policy).
- Skill files are synchronized into `/vercel/sandbox/skills/<skill-name>`.

## Important constraint

Credentials should only be injected per command execution scope. Do not rely on global/session-wide environment for privileged tokens.

Practical implication:
- Do not assume app credentials are automatically available inside the sandbox.
- Prefer short-lived installation token delivery via sandbox header transforms.

## Preferred credential strategy

1. Host/runtime obtains a short-lived GitHub installation token.
2. Apply Authorization header transforms for required API domains on the specific command execution.
3. Run the script command.
4. Ensure no long-lived token persistence in sandbox files.

Fallback:
- No credential file handoff.
- No app private key in sandbox.

## Recommended harness expansions

- Keep command env passthrough behind an explicit allowlist for secret names.
- Add configurable sandbox network policy and restrict to required domains by default.
- Inject auth headers via network policy transforms for specific APIs by default.
