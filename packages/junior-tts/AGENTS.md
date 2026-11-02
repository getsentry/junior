# TTS plugin

The plugin generates WAV narration through Vercel AI Gateway with one shared
deployment key, not per-user authorization. `skills/tts/SPEC.md` and
`scripts/speech.mjs` own the request contract.

- `AI_GATEWAY_API_KEY` stays on the host. The host proxy adds it only for
  `ai-gateway.vercel.sh`. The script never reads or accepts the key.
- The script uses one fixed endpoint and refuses redirects.
- Do not retry a request automatically. A failed request can still spend
  credits.
- Provider warnings fail generation, so voice instructions are never dropped
  silently.
- Send style as `instructions`, not prepended to the spoken text.
- Do not change `junior-v1` after it is accepted. Add a new preset version.
- The preset holds performance cues only, not the persona or user-specific
  instructions.
- Tests mock the HTTP edge and must not spend credits.
