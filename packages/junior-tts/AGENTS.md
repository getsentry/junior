# TTS plugin

- Never retry a request automatically. A failed request can still spend
  credits. Tests mock the HTTP edge.
- Send style as `instructions`. Never prepend it to the spoken text.
- Do not change `junior-v1` after it is accepted. Add a new preset version.
- The preset holds performance cues only. Never send the persona or
  user-specific instructions.
- The script never reads or accepts `AI_GATEWAY_API_KEY`.
