# @sentry/junior-elevenlabs

Generate speech with an ElevenLabs voice ID or voice link. This package includes a manifest and a script-backed skill. It adds no server hooks, SDK, or runtime package install.

## Install

```bash
pnpm add @sentry/junior @sentry/junior-elevenlabs
```

Register the package in the app's plugin set:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-elevenlabs"]);
```

Use this same plugin set in the app and its Nitro configuration. See the [plugin setup guide](https://junior.sentry.dev/extend/).

## Configure the key

1. Create a dedicated key in the ElevenLabs account that will pay for generation.
2. Limit the key to Text to Speech access and Voices read access. Set a credit limit. Account and voice plan restrictions still apply.
3. In the Junior deployment's secret settings, add `ELEVENLABS_API_KEY`. For a Vercel app, use **Project Settings → Environment Variables**, select the intended environment, and store the value as a sensitive variable. Do not commit the value or paste it in Slack.
4. Redeploy Junior with the plugin registered and the secret available.
5. Ask Junior to look up a voice. This checks access without generating paid audio.

The host proxy adds `xi-api-key` only to requests for `api.elevenlabs.io`. The script does not read, print, or accept a key. The real key never enters the Sandbox command environment. Missing host credentials block API requests.

This is a **deployment-level key**, not a personal connected account. Requests use the same ElevenLabs account and credit allowance. Enable the plugin only for a Junior deployment whose users may use that account. A lease expiry does not expire the provider key. Rotate or revoke that key in ElevenLabs, update the deployment secret, and redeploy.

There is no Slack key-entry form or per-user token vault in this package. Do not use `jr-rpc config` for secrets. Regional ElevenLabs hosts require a separate manifest and script change; this version uses the default API host only.

## Select a voice

Give Junior one of these:

- A voice ID, such as `JBFqnCBsd6RMkjVDRZzb`.
- `https://elevenlabs.io/app/voice-library?voiceId=JBFqnCBsd6RMkjVDRZzb`.
- A share link of the form `https://elevenlabs.io/voice-lab/share/OWNER_ID/VOICE_ID` (also accepts `/app/voice-lab/share/...`).

The script parses the link locally. It does not visit the supplied URL or follow redirects. It checks the voice through the API before generation. A link does not grant voice access. If a link format is not supported, use **Copy voice ID** in ElevenLabs.

Voice Library API use needs a paid ElevenLabs plan. If a voice is unavailable, check access in the account or choose another voice. The plugin does not add shared voices to the account or clone voices.

## Generate speech

Ask, for example: “Use this ElevenLabs voice link to narrate this script and attach the MP3.”

The skill runs a Node.js script inside the Sandbox. It writes one `mp3_44100_128` file per request and returns the path, byte count, MIME type, voice, and model. The default model is `eleven_multilingual_v2`. A request can contain 1–5000 characters. For a long presentation, generate one clip per scene and measure the new audio before rendering the video.

Generation spends credits and sends the script to ElevenLabs under the account's retention settings. This plugin does not promise zero retention. Failed or interrupted requests are not retried. Check provider history before a retry because generation may have completed remotely. Existing files are never overwritten; a process crash can leave a reserved or partial file that must be inspected.

## Checks

```bash
pnpm --filter @sentry/junior-elevenlabs test
```

Tests cover voice-link parsing and the fixed API/file contract with a mocked external HTTP edge. Core credential-broker coverage checks the real manifest's host-only key behavior. A live paid generation needs an operator-provided key and is not part of these checks.
