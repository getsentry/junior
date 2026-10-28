# Demo Video Specification

## Intent And Scope

Create or revise an edited video from real UI captures, optional narration, optional licensed music, and a Remotion composition. Typical outputs are product demos, narrated screen walkthroughs, animated explainers, and short presentations. Keep the story about the subject and the team's work. Preserve useful source and assets across revisions.

This is a workflow-process skill with a reference-backed shape. The runtime checklist owns the flow. `references/rendering.md` holds setup, audio, render, and export commands with revision examples. `references/motion.md` holds narration-timed animation patterns. No generator script, fixed design template, new package, or runtime dependency is required.

Raw browser recordings belong to `agent-browser`. Visual correctness checks belong to `visual-web-qa`. Audio-only requests belong to the available TTS skill. Model selection belongs to the runtime `handoff` tool; this skill only says when to use it. Deployment, event operations, email sending, voice cloning, and music generation are outside scope.

## Contract

- Resolve the brief, source, and existing artifacts before generating assets.
- Verify product claims and preserve requested credits.
- Capture the real UI safely; label synthetic fixtures and narration.
- Hand off to an implementation profile before composition when one fits better.
- Measure speech, align words, reuse unchanged clips, and keep scene offsets current.
- Time camera, highlights, cursor, captions, and on-screen text to spoken words.
- Use only user-supplied or licensed music, and keep it under the narration.
- Review still grids of every scene and transition before the full render.
- Check the delivered export, not only its source or master.
- Deliver the requested video and agreed supporting artifacts with honest limits.
- Leave the app and production unchanged unless a separate request permits changes.

## Trigger Review

Should trigger:

- “Make a short product demo with animated screenshots and narration.”
- “Use Remotion to present what we shipped.”
- “Update this demo video with the new UI and voiceover.”
- “Add a collaborator credit and the reminder feature to our presentation.”
- “Polish the animation in this video.”
- “Make a short animated explainer of this feature with a voiceover and some music.”

Should not trigger:

- “Record this loading bug.”
- “Take a mobile screenshot and check the spacing.”
- “Read this paragraph aloud.”
- “Schedule a demo and send an email reminder.”
- “Compose a background track for our video.”

## Evidence And Validation

Use the repository, safe browser captures, measured media, render logs, and user feedback. See `SOURCES.md` for provenance. Store no raw Slack transcript, secrets, private submissions, or identifying fixture data in this skill.

Validate frontmatter, bundled links, plugin packaging, and the trigger boundary. Manually review the examples for product focus, blocked authentication, scoped clip reuse, and oversized delivery. A future execution should render a short sample and verify decoding and representative frames. Structural checks do not prove narration quality or agent behavior.

## Limits And Maintenance

Remotion, FFmpeg, and `faster-whisper` are not provisioned by this skill. Speech needs the appropriate enabled plugin or supplied audio. Music needs a user-supplied or licensed track. Commercial Remotion use needs an appropriate license. ASR word times are close but not exact; captions without alignment remain approximate. Audio-energy motion is not lip sync.

Update commands after incompatible Remotion changes. Keep tool setup and credentials in their owning plugins. Extend the existing references only for a demonstrated failure or recurring task. Keep brand choices, project compositions, and assets out of this skill; do not turn it into a general video platform.
