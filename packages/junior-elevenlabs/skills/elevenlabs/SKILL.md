---
name: elevenlabs
description: Generates speech and voiceovers with ElevenLabs. Use when users request ElevenLabs narration, choose a voice by ID or voice link, search available voices, or replace a video's narration with an ElevenLabs voice. Do not use for voice cloning, transcription, music generation, or video rendering itself.
---

# ElevenLabs

Use `scripts/elevenlabs.mjs` from this skill directory. It needs Node.js and the installed plugin's host-managed credentials. Do not install an SDK or ask for a key in chat.

## Workflow

1. Resolve the user's script and voice. Accept a voice ID, a voice-library link with `voiceId`, or a voice-lab share link. Do not choose a different voice when a requested voice is unavailable.
2. Check the voice before generating. If the user only gives a voice description, search and ask them to choose when the match is not clear.
3. Write the requested narration to a UTF-8 text file. Use 1–5000 characters per request. Split longer narration by scene. Generation spends the deployment account's credits and sends the text to ElevenLabs. Generate only the requested content; do not send unrelated private data.
4. Generate to a new `.mp3` path. Never overwrite a clip or repeat a paid request just to test access.
5. Share the file with `sendFiles`. For a video, hand the audio to the rendering workflow and measure its duration before changing scene timing. Do not claim a video was updated when only its audio was generated.

## Commands

```bash
# Read-only: up to 20 available voices, with an optional search term.
node scripts/elevenlabs.mjs voices --search 'narration'

# Read-only: validate the supplied voice ID or link against the account.
node scripts/elevenlabs.mjs voice --voice 'https://elevenlabs.io/app/voice-library?voiceId=JBFqnCBsd6RMkjVDRZzb'

# Paid: generate one MP3. Omit --model to use eleven_multilingual_v2.
node scripts/elevenlabs.mjs speak \
  --voice 'https://elevenlabs.io/app/voice-library?voiceId=JBFqnCBsd6RMkjVDRZzb' \
  --text-file /tmp/narration.txt --output /tmp/narration.mp3
```

The script writes JSON. Speech results include `path`, `bytes`, `mimeType`, voice metadata, and model. Voice search returns `hasMore`; if true, narrow the search rather than treating the page as the full library. Use `--help` for arguments. Do not pass an API key or token flag.

## Failures and boundaries

- Missing `ELEVENLABS_API_KEY` or HTTP 401: ask the operator to configure or rotate the host-side deployment secret and redeploy. A missing Sandbox env value is expected; do not inspect or print secrets.
- HTTP 403/404: report voice access or account restrictions. Ask the user to make the voice available in the connected ElevenLabs account or choose another voice. Do not import, clone, or buy a voice automatically.
- An unsupported link: ask for **Copy voice ID** from ElevenLabs. Do not follow redirects or guess an ID from an arbitrary URL.
- HTTP 429, timeout, non-audio response, or interrupted generation: stop. Credits may have been used. Check ElevenLabs history before any user-authorized retry. The script does not retry requests.
- An existing output file: inspect it before generating again. Use a new path only for an explicitly requested new generation.
- A missing script or Node.js: report a plugin runtime setup failure. Do not improvise a token-bearing command.
- Voice cloning, creating keys, changing account settings, and per-user key storage are outside this plugin. A voice link selects a voice; it does not grant permission to use it.
- Label generated narration as synthetic. Do not imply that a real person recorded it.
