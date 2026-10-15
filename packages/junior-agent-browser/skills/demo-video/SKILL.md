---
name: demo-video
description: Creates and revises edited videos with Remotion, such as product demos, narrated screen walkthroughs, animated explainers, and short presentations built from browser captures, with optional narration, captions, and music. Use when asked to make, animate, polish, or update a video or presentation of an app or shipped work. Do not use for a raw browser recording, screenshot-only visual QA, or audio-only text-to-speech.
---

# Demo Video

Make the subject the story. For a product, show what people can do, why it matters, and what the team built. Use personality in the delivery, not as the story. Do not introduce a revision as a new take or talk about the narrator's voice unless asked.

| Open when you need to...                                                                                          | Read                                               |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| set up Remotion, measure clips, mix music, render, check an export, or see revision examples                      | [references/rendering.md](references/rendering.md) |
| time motion to the narration: word alignment, camera moves, highlights, cursor, captions, transitions, and stills | [references/motion.md](references/motion.md)       |

## 0. Pick The Model Profile

Composition, motion timing, and frame review are implementation work. When `handoff` is available and a listed profile fits implementation better than the active one, switch before step 1. If the requester names a model or profile, use it when it is available. Do not hand off only to summarize finished work.

## 1. Resolve The Brief And Reuse Work

- Read the current request and prior decisions. Keep the agreed audience, length, tone, credits, and destination. Ask only for a missing decision that blocks work.
- Find the existing source, assets, and attachments before rebuilding. Sandbox files can disappear between turns. Look for an earlier source archive in the conversation and load it. If no source exists, say this will be a fresh composition.
- Inspect the target UI and relevant repository history before writing claims about shipped behavior. Use the repository skill for code access. Do not present an unmerged feature as live.
- Draft a short scene list with one point per scene. Match each claim to a capture or verified source. Name collaborators when requested and supported.
- Separate product capabilities from actions taken during this task. Describing reminder emails does not authorize sending one.

## 2. Capture The Actual UI

Load `agent-browser` for browser commands. Use `visual-web-qa` when the request also asks whether the UI works or looks correct.

- Prefer a reachable local or preview page for the requested revision. Use an authorized session for private pages; do not bypass sign-in.
- If private data prevents safe capture, use the real UI with isolated synthetic fixtures. Label that data in the video. Do not make a lookalike and call it the app.
- Keep the fixture server local. Prevent it from sending writes, email, or uploads to production. Do not reuse customer submissions or secrets.
- Capture each state the narration mentions: open panels, dark theme, player cards, and mobile views. Add small synthetic fixtures when a state needs data. Use full-page captures when the camera must scroll.
- Record element boxes from the DOM at the capture viewport. Highlights and cursor targets use these boxes; see the motion reference.
- Use screenshots for stable pages. Use short browser recordings when an interaction or motion is part of the story. Stop recordings after the required flow.
- Wait for expected content and fonts. Open the captures before using them. Check for loading states, clipping, mismatched fixture counts, and sensitive content.

For a raw interaction recording without an edited presentation, use `agent-browser` alone. Do not add a Remotion project by default.

## 3. Prepare Narration And Music

- Write spoken text separately from scene layout and delivery directions. Keep the opening about the work. Put credits and operational capabilities where they support the story.
- For requested speech, load the available TTS skill and use its credential, cost, and retry rules. Use the agreed voice preset. Do not silently replace a missing provider with another voice.
- Generate one clip per scene to make revisions cheap. Reuse unchanged clips and generate changed text to fresh paths. A visual-only edit needs no new speech request.
- Measure each clip. Align its words to get word times. Derive scene frames from the last spoken word plus explicit lead and tail time. Recompute later scene offsets after a clip changes.
- Keep captions tied to the final script and the word times. If alignment is unavailable, say that caption timing is approximate. Audio-energy avatar motion is not lip sync.
- Music is optional. Use only a track that the user supplies or that has a clear license for this use. Do not generate, download, or imitate music without a stated source and license. Keep music under the narration; see the rendering reference.

## 4. Compose And Render

- Use a separate artifact directory unless the user asked to change the app. Keep composition source, local assets, scene data, and outputs together.
- Reuse an existing Remotion project and lockfile. For a new project, follow the rendering reference. Browser runtime setup remains owned by the plugin; report a missing runtime instead of repairing it here.
- Match the app's type, colors, and approved assets. Keep UI text readable.
- Time every move to a spoken word: camera, highlight, cursor click, caption, and on-screen text. Show one focal point at a time. Use pans, zooms, short wipes, and springs instead of expensive effects. Label any illustration that is not a real screen.
- Bundle images, fonts, and audio locally. Drive motion from frame numbers, not wall-clock timers or network calls during render.
- Render stills for each scene and transition before a full video. Fix crops, collisions, and empty states, then render again. Use a short frame range to diagnose failures.
- Set export resolution and audio bitrate for the destination early. Keep the source at full composition size. A smaller delivery copy need not change the scene design.

## 5. Check And Deliver

- Decode the full exported video and audio. Inspect frames from every scene, including transitions, first/last frames, captions, and any changed crop. Check durations, missing audio, loudness, peaks, and final-frame truncation.
- Listen when audio review is available. Decode and level checks do not prove pronunciation, timing, or listening quality; report unchecked limits.
- Check the actual file size before attachment. If too large, re-encode the existing master with a smaller delivery profile. Recheck that file. Do not regenerate speech or publish a public URL to work around the limit.
- Inspect outputs and logs after a timeout before repeating a render. Never infer success from a file's existence alone.
- Deliver the video with `sendFiles`. Include standalone synthetic narration and editable source when requested or already agreed. Exclude dependencies, caches, secrets, and unused revisions from the source archive.
- Report successful attachments, duration, checks, and remaining limits. Record capture provenance, alignment, music license, and rerender commands in the artifact README. Do not say the app or production changed when only the video changed.
