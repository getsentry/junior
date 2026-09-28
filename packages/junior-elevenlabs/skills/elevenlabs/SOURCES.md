# ElevenLabs Sources and Decisions

Reviewed 2026-09-28.

## Sources

- Official [authentication docs](https://elevenlabs.io/docs/api-reference/authentication): `xi-api-key`, scope restrictions, credit quotas. High confidence.
- Official [speech API](https://elevenlabs.io/docs/api-reference/text-to-speech/convert.md): fixed endpoint, model, binary audio, format, and plan limits. High confidence.
- Official [voice lookup](https://elevenlabs.io/docs/api-reference/voices/get.md) and [voice search](https://elevenlabs.io/docs/api-reference/voices/search.md): voice metadata and bounded search. High confidence.
- Official [Voice Library](https://elevenlabs.io/docs/eleven-creative/voices/voice-library): Copy voice ID, share links, account access, and paid-plan API restriction. High confidence for product behavior. The page does not specify a versioned URL grammar.
- `packages/junior-datadog/plugin.yaml` and `README.md`: deployment-level host-managed header pattern.
- `packages/junior/src/chat/plugins/auth/api-headers-broker.ts` and its existing tests: host header resolution and missing-key behavior.
- `packages/junior/scripts/check-skills.mjs`, repo policies, and the skill-writer workflow: package registration and skill format.

## Decisions and coverage

- Class: integration-documentation. Shape: script-backed workflow. Plain shell guidance was rejected because user-supplied voice links, binary output, and paid retries need fixed rules.
- Adopted: manifest-only package, exact API host, no Sandbox token, local URL parsing, voice preflight, default MP3, and no automatic retry.
- Added with reason: one Node.js script for deterministic parsing and output handling. The runtime skill stays short; setup belongs in the package README.
- Rejected: a new credential system, arbitrary endpoints, SDK installation, or automatic voice import. Existing core credential rules already cover host storage.
- API, configuration, downstream narration, and expected failures are covered. The script uses v1 voice lookup/speech and v2 voice search.
- Portability: the script requires Node.js and Junior's host proxy. It intentionally has no standalone key argument.
- Gaps: no live key or paid voice test. Voice URL formats are not a documented stable API; support is limited to explicit `voiceId` links and the known voice-lab share layout. Unknown forms fail with a request for Copy voice ID.
- Retrieval stopped after official API contracts and local credential patterns were covered. No account-specific behavior can be verified without a configured key.

These are implementation notes, not provider guarantees. Do not store private scripts, real keys, or account identifiers here.
