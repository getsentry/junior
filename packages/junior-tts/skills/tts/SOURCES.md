# TTS Sources and Decisions

Reviewed 2026-09-28.

- [Vercel text-to-speech](https://vercel.com/docs/ai-gateway/modalities/text-to-speech): authoritative REST endpoint, protocol headers, base64 response, separate instructions, WAV output, and beta access limits.
- [Gemini 3.8 launch](https://vercel.com/changelog/gemini-3-8-text-to-speech-models-now-available-on-ai-gateway): model availability and expressive character delivery.
- User-supplied Junior personality: practical, concise, evidence-first, warm, mildly playful, with dry humor; plain delivery for serious topics. Transformed into original performance cues. No raw persona file or user-specific identity rules are sent to TTS.
- `packages/junior-datadog/plugin.yaml`: existing host-managed API-header pattern.
- `packages/junior/src/chat/plugins/auth/api-headers-broker.ts`: host-only secret resolution and missing-key behavior.
- `packages/junior/src/chat/pi/gateway-auth.ts`: core prefers OIDC. This plugin does not import core internals or claim that it shares that path.
- Repo skill validator and skill-writer guidance: registration and artifact layout.

Class: integration-documentation. Shape: script-backed workflow. Plain instructions alone were rejected because paid requests and base64 audio need consistent validation. No SDK or new core runtime contract is needed. The script requires Junior's host proxy; it is not a standalone credential client.

Coverage: API, key setup, narration workflow, failure handling, protocol version, and delivery are documented and tested. Added one preset to keep voice identity reusable and one sample script for listening review. No provider selection layer, key-entry UI, or unrelated persona rules were added.

Gaps: no live Gateway speech credential or listening test at authoring time. The user-provided AI Studio guide returned an empty page through text fetch; the current Vercel provider documentation is the protocol source. Further source collection cannot verify team-specific access. A real sample remains a deployment smoke test.
