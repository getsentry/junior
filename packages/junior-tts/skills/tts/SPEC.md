# TTS Skill Specification

## Intent

Create requested synthetic narration with a reusable original Junior voice. Use Gemini 3.8 Flash TTS through Vercel AI Gateway, not OpenRouter. Keep the key on the host.

## Scope and Contract

The manifest owns credentials and the approved domain. `scripts/speech.mjs` owns request validation, the REST protocol, audio decoding, and output files. `assets/junior-v1.json` owns the playful voice identity. `assets/sample.txt` is a non-sensitive sample script. `SKILL.md` owns narration scope, delivery mode, retries, and sharing.

Out of scope: voice cloning, per-user key storage, OIDC support, transcription, video rendering, automatic retries, deployment changes, and alternate providers.

## Triggers and Validation

Should trigger: “Read this aloud”; “Give me a Junior voice sample”; “Make a Gemini voiceover for this demo.”

Should not trigger: “Transcribe this clip”; “Clone this performer's voice”; “Make a silent animation.”

Run package tests, core credential-broker tests, skills validation, and package/release checks. Local tests mock only the HTTP edge and use generated WAV fixture bytes. Live validation needs an installed plugin, a funded key, and team speech access. Do not claim a listening-approved voice from mock tests.

## Maintenance

Keep provenance in `SOURCES.md`. Confirm the Gateway endpoint and headers when its speech protocol changes. Preserve the distinction between base64 JSON from Gateway and raw audio from other APIs. Version accepted voice changes. Do not store credentials, customer scripts, or private account details in fixtures.
