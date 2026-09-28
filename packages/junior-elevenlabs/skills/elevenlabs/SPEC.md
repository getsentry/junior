# ElevenLabs Skill Specification

## Intent and scope

Generate requested narration with an existing ElevenLabs voice. Accept a voice ID or supported voice link. Keep the API key on the host through the plugin manifest.

Out of scope: key-entry UI, per-user keys, voice cloning, shared-voice import, transcription, music, video rendering, and regional API hosts.

## Trigger context

Should trigger: “Use this ElevenLabs voice link for the narration”; “Find an ElevenLabs narrator”; “Replace the voiceover with this ElevenLabs voice ID.”

Should not trigger: “Clone my voice”; “Transcribe this recording”; “Render a Remotion video” without an ElevenLabs request; “Explain API key storage.”

## Runtime contract

`scripts/elevenlabs.mjs` owns URL validation, API requests, output validation, and exclusive file creation. `SKILL.md` owns voice choice, narration scope, delivery, and decisions after failure. `plugin.yaml` owns host credentials and the single approved API domain.

Speech spends credits. Do not retry automatically. Do not substitute voices or change the user's account. Return an existing generated audio file only after success. Never accept or store secrets in skill inputs or evidence.

## Validation and maintenance

Run package tests, the existing core credential-broker tests, skills validation, and package/release checks. Test API calls at the external HTTP edge without real credits. A live smoke test needs an operator's configured key.

Keep protocol evidence and gaps in `SOURCES.md`. Update parser fixtures if ElevenLabs changes voice links. Review paid-request behavior when adding endpoints. Keep provider rules in this package, not core.
