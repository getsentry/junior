---
name: demo-video
description: Creates and revises product demo videos and narrated walkthroughs from browser captures with Remotion. Use for a short presentation of an app or shipped work, animated screenshots, or a video update with new narration. Do not use for a raw browser recording, screenshot-only visual QA, or audio-only text-to-speech.
---

# Demo Video

Make the product the subject. Show what people can do, why it matters, and what the team built. Use personality in the delivery, not as the story. Do not introduce a revision as a new take or talk about the narrator's voice unless asked.

Open [references/rendering.md](references/rendering.md) when setting up Remotion, measuring clips, rendering, or checking an export. It includes commands and revision examples.

## 1. Resolve The Brief And Reuse Work

- Read the current request and prior decisions. Keep the agreed audience, length, tone, credits, and destination. Ask only for a missing decision that blocks work.
- Find the existing source, assets, and attachments before rebuilding. If the source is missing, say this will be a fresh composition.
- Inspect the target UI and relevant repository history before writing claims about shipped behavior. Use the repository skill for code access. Do not present an unmerged feature as live.
- Draft a short scene list with one point per scene. Match each claim to a capture or verified source. Name collaborators when requested and supported.
- Separate product capabilities from actions taken during this task. Describing reminder emails does not authorize sending one.

## 2. Capture The Actual UI

Load `agent-browser` for browser commands. Use `visual-web-qa` when the request also asks whether the UI works or looks correct.

- Prefer a reachable local or preview page for the requested revision. Use an authorized session for private pages; do not bypass sign-in.
- If private data prevents safe capture, use the real UI with isolated synthetic fixtures. Label that data in the video. Do not make a lookalike and call it the app.
- Keep the fixture server local. Prevent it from sending writes, email, or uploads to production. Do not reuse customer submissions or secrets.
- Capture a few useful states and relevant desktop/mobile views. Save the route, viewport, theme, and source revision with each asset.
- Use screenshots for stable pages. Use short browser recordings when an interaction or motion is part of the story. Stop recordings after the required flow.
- Wait for expected content and fonts. Open the captures before using them. Check for loading states, clipping, mismatched fixture counts, and sensitive content.

For a raw interaction recording without an edited presentation, use `agent-browser` alone. Do not add a Remotion project by default.

## 3. Prepare Narration

- Write spoken text separately from scene layout and delivery directions. Keep the opening about the work. Put credits and operational capabilities where they support the story.
- For requested speech, load the available TTS skill and use its credential, cost, and retry rules. Use the agreed voice preset. Do not silently replace a missing provider with another voice.
- Generate one clip per scene to make revisions cheap. Reuse unchanged clips and generate changed text to fresh paths. A visual-only edit needs no new speech request.
- Measure each clip. Derive scene frames from its duration plus explicit lead and tail time. Recompute later scene offsets after a clip changes.
- Keep captions tied to the final script. Use real alignment when available; otherwise state that word-count timing is approximate. Audio-energy avatar motion is not lip sync.

## 4. Compose And Render

- Use a separate artifact directory unless the user asked to change the app. Keep composition source, local assets, scene data, and outputs together.
- Reuse an existing Remotion project and lockfile. For a new project, follow the setup reference. Browser runtime setup remains owned by the plugin; report a missing runtime instead of repairing it here.
- Match the app's type, colors, and approved assets. Keep UI text readable. Use simple cuts, pans, and small transitions instead of expensive effects.
- Bundle images, fonts, and audio locally. Drive motion from frame numbers, not wall-clock timers or network calls during render.
- Render stills for each layout before a full video. Start with low concurrency in a small Sandbox. Use a short frame range to diagnose failures.
- Set export resolution and audio bitrate for the destination early. Keep the source at full composition size. A smaller delivery copy need not change the scene design.

## 5. Check And Deliver

- Decode the full exported video and audio. Inspect frames from every scene, including transitions, first/last frames, captions, and any changed crop. Check durations, missing audio, peaks, and final-frame truncation.
- Listen when audio review is available. Decode and level checks do not prove pronunciation, timing, or listening quality; report unchecked limits.
- Check the actual file size before attachment. If too large, re-encode the existing master with a smaller delivery profile. Recheck that file. Do not regenerate speech or publish a public URL to work around the limit.
- Inspect outputs and logs after a timeout before repeating a render. Never infer success from a file's existence alone.
- Deliver the video with `sendFiles`. Include standalone synthetic narration and editable source when requested or already agreed. Exclude dependencies, caches, secrets, and unused revisions from the source archive.
- Report successful attachments, duration, checks, and remaining limits. Record capture provenance and rerender commands in the artifact README. Do not say the app or production changed when only the video changed.
