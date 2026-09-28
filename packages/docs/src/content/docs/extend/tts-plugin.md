---
title: TTS Plugin
description: Generate Junior voiceovers with Gemini through Vercel AI Gateway.
type: tutorial
summary: Install the TTS plugin, configure host credentials, and generate a reusable Junior voice sample.
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
---

The TTS plugin uses `google/gemini-3.8-flash-tts` through Vercel AI Gateway. It generates WAV audio with a reusable Junior voice. No OpenRouter or Google API key is needed.

## Install

```sh
pnpm add @sentry/junior @sentry/junior-tts
```

Register the package in the app's plugin set and use the same set for the app and `juniorNitro`:

```ts
import { defineJuniorPlugins } from "@sentry/junior";
export const plugins = defineJuniorPlugins(["@sentry/junior-tts"]);
```

## Configure Credentials

Set `AI_GATEWAY_API_KEY` in the Junior app's deployment secrets. On Vercel, use **Project Settings → Environment Variables**, select the intended environment, and mark it sensitive. Redeploy after installing and registering the plugin.

The plugin can reuse an existing Gateway API key with speech access and credits. It does **not** reuse core's Vercel OIDC authentication. An OIDC-only deployment needs an operator-provided Gateway API key for this plugin. Speech access is in beta and can vary by team.

The host adds the bearer key only to `ai-gateway.vercel.sh` requests. The script does not receive or read the key. Do not put secrets in Slack, Git, the Sandbox, or `jr-rpc config`. This is a shared deployment account; use a spending limit and enable it only for authorized users. The domain permission is not limited to one Gateway route, though the bundled script only calls speech.

## Junior Voice

`junior-v1` uses the prebuilt `Puck` voice with separate delivery instructions. It is bright, warm, clear, mischievous, and gently snarky. It is an original adult helper voice, not a performer or character imitation. For serious material, plain mode keeps the voice but drops the teasing.

The preset is stored in `skills/tts/assets/junior-v1.json`. The sample script is in `skills/tts/assets/sample.txt`. These files are reusable inputs, not proof of a generated or listening-approved voice. The same preset cannot guarantee identical audio after provider updates.

Ask Junior:

> Generate the bundled Junior voice sample and attach the WAV.

Or:

> Narrate this incident update using plain delivery.

## Limits and Failures

Each clip can contain 1–5000 characters. Longer scripts need separate scenes. Generation spends credits and sends the requested text and delivery directions to Gateway and its provider. This plugin does not promise zero retention.

The script uses the documented Gateway REST speech endpoint, decodes its base64 response, and checks the WAV before delivery. It rejects provider warnings rather than silently dropping voice instructions. Output files are not overwritten. Requests are not retried automatically.

- Missing key or HTTP 401/403: check the deployment key and team speech access.
- HTTP 402: check credits and spending limits.
- HTTP 404: check model availability for the team.
- Timeout, warning, or bad audio: check Gateway usage before authorizing another generation. Credits may have been used.
- Existing file: inspect it first. A process crash can leave a reserved or partial file.

No voice cloning, transcription, music, or video rendering is included. To replace a video's narration, measure the new audio and update the video in its rendering workflow.

See [Vercel's TTS guide](https://vercel.com/docs/ai-gateway/modalities/text-to-speech) for the current API and rollout limits.
