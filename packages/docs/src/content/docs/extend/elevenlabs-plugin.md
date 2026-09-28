---
title: ElevenLabs Plugin
description: Generate narration with ElevenLabs voice links and a host-managed API key.
type: tutorial
summary: Install ElevenLabs, configure a deployment key, and generate an MP3 with a selected voice.
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
---

The ElevenLabs plugin generates speech with an existing voice. Users can provide a voice ID or voice link. It includes voice lookup, bounded voice search, and MP3 generation. It does not clone voices or render videos.

## Install and Register

```bash
pnpm add @sentry/junior @sentry/junior-elevenlabs
```

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-elevenlabs"]);
```

Pass this plugin set to both the app and `juniorNitro`. See [Plugins](/extend/).

## Store the API Key

1. Create a dedicated API key in ElevenLabs. Allow Text to Speech and Voices read access. Set a credit limit.
2. Store `ELEVENLABS_API_KEY` in the Junior deployment's secret settings. For Vercel, use **Project Settings → Environment Variables**, select the target environment, and mark the variable as sensitive.
3. Redeploy with the plugin registered and the secret available.
4. Ask Junior to look up a voice before generating speech. Lookup does not generate paid audio.

Do not paste the key into Slack, a repository file, or `jr-rpc config`. There is no per-user key-entry form in this plugin.

Junior adds the key as `xi-api-key` only for `api.elevenlabs.io`. The key stays on the host. The Sandbox script does not receive a key environment variable or accept a token argument. Missing credentials block the request.

This is a shared deployment account. Its credit allowance applies to all authorized use of the plugin. Enable it only where users may use that account. To rotate a key, revoke it in ElevenLabs, replace the deployment secret, and redeploy.

## Provide a Voice

Give Junior a voice ID, a Voice Library link with `voiceId`, or a voice-lab share link:

```text
Use https://elevenlabs.io/app/voice-library?voiceId=JBFqnCBsd6RMkjVDRZzb
for this narration and attach the MP3: “Here is what we built this week.”
```

The parser also accepts `https://elevenlabs.io/voice-lab/share/OWNER_ID/VOICE_ID` and its `/app/voice-lab/share/...` form. It extracts the ID locally. It never fetches the supplied link or follows redirects.

If the format is not supported, use **Copy voice ID** in ElevenLabs. A link selects a voice; it does not grant access. Voice Library API use requires a paid ElevenLabs plan. Make the voice available in the deployment's account before using it.

## Generation and Limits

- Output: one MP3 at `mp3_44100_128` per request.
- Default model: `eleven_multilingual_v2`; the script also accepts an explicit model ID.
- Text: 1–5000 characters per request. Split longer narration into scenes.
- Privacy: the requested text goes to ElevenLabs under the account's retention settings. This plugin does not enable zero retention.
- Cost: generation spends credits. Requests are not retried automatically, and existing output files are not overwritten.
- Video use: measure the new audio and adjust scene timing in the rendering workflow. Generating audio alone does not update a video.

## Troubleshooting

- Missing key or HTTP 401: the operator must check the deployment secret and redeploy.
- HTTP 403/404: check key scopes, the selected voice, and account-plan access. The plugin does not import or purchase voices.
- HTTP 429: check rate limits and the account's remaining credits.
- Timeout or interrupted generation: check ElevenLabs history before retrying. The provider may have generated audio and charged credits even if no local file was saved.
- Existing file: inspect it before requesting another generation. A process crash can leave a reserved or partial file.

This version uses only the default ElevenLabs API host. It does not support regional endpoints, personal OAuth, voice cloning, music, or transcription.
