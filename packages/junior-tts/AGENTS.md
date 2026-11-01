# TTS plugin

## Intent

- The plugin generates WAV narration through Vercel AI Gateway. It uses one
  shared deployment key, not per-user authorization.
- `skills/tts/SPEC.md` and `scripts/speech.mjs` own the request contract.

## Rules

- `AI_GATEWAY_API_KEY` stays on the host. The host proxy adds it only for
  `ai-gateway.vercel.sh`. The script never reads or accepts the key.
- The script uses one fixed endpoint and refuses redirects.
- Never retry a request automatically. A failed request can still spend
  credits.
- Provider warnings fail generation. Do not drop voice instructions silently.
- Send style as `instructions`. Never prepend it to the spoken text.
- Do not change `junior-v1` after it is accepted. Add a new preset version.
- The preset holds performance cues only. Never send the full persona or
  user-specific instructions.
- Tests mock the HTTP edge and must not spend credits.
