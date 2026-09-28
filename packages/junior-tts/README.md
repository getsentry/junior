# @sentry/junior-tts

Generate WAV narration through Vercel AI Gateway with `google/gemini-3.8-flash-tts`. Includes a reusable `junior-v1` voice preset and a short sample script. No OpenRouter account, Google key, SDK install, or voice cloning is needed.

## Setup

```sh
pnpm add @sentry/junior @sentry/junior-tts
```

Register the package in the app's shared plugin set:

```ts
import { defineJuniorPlugins } from "@sentry/junior";
export const plugins = defineJuniorPlugins(["@sentry/junior-tts"]);
```

Use the same plugin set for the app and `juniorNitro`. See [plugin setup](https://junior.sentry.dev/extend/).

Set **`AI_GATEWAY_API_KEY` on the host deployment**. In Vercel, use the Junior app project's Settings → Environment Variables, select the intended environment, and mark the variable sensitive. Then redeploy with the plugin installed and registered. Do not paste the key into Slack, Git, `jr-rpc config`, or the Sandbox.

An existing deployment API key can be reused if the team has speech access and credits. **This manifest does not reuse core's Vercel OIDC credential flow.** If the app uses only OIDC, an operator must provision a Gateway API key for this plugin. No new secret is needed when a suitable `AI_GATEWAY_API_KEY` already exists. Speech is in beta; availability can differ by team.

The host proxy inserts the bearer key only for `ai-gateway.vercel.sh`. The script neither reads nor accepts the key. This is a shared deployment account, not per-user authorization. Enable it only where users may spend that account's credits. Use a dedicated key with a spending limit when isolation is needed. Rotate the key in Vercel, replace the deployment value, and redeploy.

The domain permission covers the Gateway host, not only the speech route. The bundled script uses one fixed speech endpoint and refuses redirects; it does not create an endpoint-level credential restriction.

## Junior Voice

`skills/tts/assets/junior-v1.json` pairs the prebuilt `Puck` voice with sustained delivery instructions: bright, warm, quietly confident, lightly raspy, mischievous, and gently snarky. It is an original adult helper voice, not an imitation of a character or performer.

The preset translates the supplied Junior persona into performance cues. It does not transmit the full persona or unrelated user-specific instructions. Model and voice selection are pinned in the preset; style is sent separately as `instructions`, never prepended to the spoken text. Reusing a preset does not guarantee identical audio across provider updates.

Use `--delivery plain` for serious or sensitive material. It keeps the same voice but removes teasing and dramatic delivery. Version a changed voice identity as a new preset rather than silently changing `junior-v1` after it is accepted.

## Generate the Sample

From the skill directory, with the plugin active:

```sh
node scripts/speech.mjs --profile
node scripts/speech.mjs --sample --output /tmp/junior-sample.wav
node scripts/speech.mjs --text-file /tmp/narration.txt --output /tmp/narration.wav
node scripts/speech.mjs --text-file /tmp/incident.txt --output /tmp/incident.wav --delivery plain
```

Sample text:

> Hey, I'm Junior. I check the evidence, do the work, and keep the recap short. Fewer mystery errors. Fewer meetings about mystery errors. That's the dream, anyway. Show me what you're building. Let's make it work.

The sample is a generation recipe, **not a recorded or listening-approved sample**. A real clip requires an active plugin, a funded key, and team model access. Share generated audio with `sendFiles`; for PR evidence, link the delivered sample or an approved artifact location. Do not label synthetic narration as a recording by a person.

## Request Contract

- Fixed REST endpoint: `https://ai-gateway.vercel.sh/v4/ai/speech-model`.
- Headers: Gateway protocol `0.0.1`, speech model specification `4`, selected model ID. Authorization is host-managed.
- Request: `text`, `voice`, `instructions`, and `outputFormat: wav`.
- Response: JSON with base64 `audio`; decode before saving. This is **not** OpenRouter's raw-audio endpoint.
- Maximum: 5,000 characters per clip, a local limit. Split longer scripts into scenes.
- Exclusive output creation avoids overwrites. Failures remove incomplete local files; an abrupt process exit can leave a reserved file that needs inspection.
- No automatic retry. A timeout or local validation failure after the request can still spend credits. Check Gateway usage before an authorized retry.
- Provider warnings fail generation rather than silently dropping voice instructions.
- The requested text and voice directions go to Vercel and its model provider. This plugin does not promise zero retention.

No deployment changes or keys are included. Unit/component checks use a mocked HTTP edge and do not spend credits:

```sh
pnpm --filter @sentry/junior-tts test
```

References: [Vercel TTS](https://vercel.com/docs/ai-gateway/modalities/text-to-speech), [Gemini TTS launch](https://vercel.com/changelog/gemini-3-8-text-to-speech-models-now-available-on-ai-gateway).
