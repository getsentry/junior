---
name: tts
description: Generates spoken narration with Gemini TTS through Vercel AI Gateway. Use for text-to-speech, audio samples, voiceovers, or speaking as Junior with the reusable Junior voice. Do not use for transcription, voice cloning, music generation, or rendering a video without a narration request.
---

# Text to Speech

Use the bundled `scripts/speech.mjs` from this directory. Node.js and the installed plugin's host-managed Gateway key are required. Do not install an SDK or ask for secrets in chat.

## Workflow

1. Resolve the requested spoken text. For a sample of Junior's voice, use the bundled sample. Do not send unrelated private context or the full persona to the provider.
2. Use the default `junior-v1` preset: a bright, warm, mischievous adult helper with dry humor. Use `--delivery plain` for serious or sensitive text. Do not present it as an imitation or recording of a real performer.
3. Write narration to a UTF-8 file. Keep each clip at 1–5000 characters. Generation spends Gateway credits. Do not generate extra variants without a request.
4. Generate to a fresh `.wav` path. Inspect an existing file before trying again. Do not automatically retry timeouts or failures: generation may already have spent credits.
5. Use `sendFiles` to deliver the returned path as `audio/wav`. Say it is synthetic narration. For a video, measure the new audio and pass it to the rendering workflow; speech generation alone does not update the video.

## Commands and Assets

```sh
# Local, no API call: show the reusable voice preset.
node scripts/speech.mjs --profile

# Paid: generate the bundled Junior sample.
node scripts/speech.mjs --sample --output /tmp/junior-sample.wav

# Paid: generate requested narration.
node scripts/speech.mjs --text-file /tmp/narration.txt --output /tmp/narration.wav

# Paid: use the same voice without snark.
node scripts/speech.mjs --text-file /tmp/incident.txt --output /tmp/incident.wav --delivery plain
```

Read `assets/junior-v1.json` when the user asks how the voice is defined. Read `assets/sample.txt` when previewing the sample script. The script sends delivery instructions separately from text. Do not prepend those directions to narration.

Results are JSON with path, bytes, MIME type, model, voice, profile, delivery, and synthetic status. Use `--help` for the command surface. No key argument is accepted.

## Failures

- Missing host key or HTTP 401/403: ask the operator to check `AI_GATEWAY_API_KEY`, plugin registration, and team speech access, then redeploy. A missing key in the Sandbox is expected. Core's OIDC authentication is not reused by this manifest-only plugin.
- HTTP 402: ask the operator to check credits and spending limits.
- HTTP 404: report that the requested Gemini model is unavailable for the team. Do not silently choose a different model or provider.
- Timeout, provider warning, or bad audio: stop and check Gateway usage before a user-authorized retry. Do not claim that an audio file was created or approved by listening.
- Missing script or Node.js: report plugin setup failure. Do not improvise a token-bearing command.
- Missing credentials: share the preset and script as a recipe, clearly labeled as not generated audio.
