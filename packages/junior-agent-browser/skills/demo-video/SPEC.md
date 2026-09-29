# Demo Video Specification

## Intent And Scope

Create or revise an edited product presentation from real UI captures, optional narration, and a Remotion composition. Keep the story about the product and the team's work. Preserve useful source and assets across revisions.

This is a workflow-process skill with a reference-backed shape. The runtime checklist owns the flow. One reference holds optional rendering commands and examples. No generator script, fixed design template, new package, or runtime dependency is required by this change.

Raw browser recordings belong to `agent-browser`. Visual correctness checks belong to `visual-web-qa`. Audio-only requests belong to the available TTS skill. Deployment, event operations, email sending, and voice cloning are outside scope.

## Contract

- Resolve the brief, source, and existing artifacts before generating assets.
- Verify product claims and preserve requested credits.
- Capture the real UI safely; label synthetic fixtures and narration.
- Measure speech, reuse unchanged clips, and keep scene offsets current.
- Check the delivered export, not only its source or master.
- Deliver the requested video and agreed supporting artifacts with honest limits.
- Leave the app and production unchanged unless a separate request permits changes.

## Trigger Review

Should trigger:

- “Make a short product demo with animated screenshots and narration.”
- “Use Remotion to present what we shipped.”
- “Update this demo video with the new UI and voiceover.”
- “Add a collaborator credit and the reminder feature to our presentation.”

Should not trigger:

- “Record this loading bug.”
- “Take a mobile screenshot and check the spacing.”
- “Read this paragraph aloud.”
- “Schedule a demo and send an email reminder.”

## Evidence And Validation

Use the repository, safe browser captures, measured media, render logs, and user feedback. See `SOURCES.md` for provenance. Store no raw Slack transcript, secrets, private submissions, or identifying fixture data in this skill.

Validate frontmatter, bundled links, plugin packaging, and the trigger boundary. Manually review the examples for product focus, blocked authentication, scoped clip reuse, and oversized delivery. A future execution should render a short sample and verify decoding and representative frames. Structural checks do not prove narration quality or agent behavior.

## Limits And Maintenance

Remotion and FFmpeg are not provisioned by this skill. Speech needs the appropriate enabled plugin or supplied audio. Commercial Remotion use needs an appropriate license. Captions based on word counts remain approximate. Audio-energy motion is not lip sync.

Update commands after incompatible Remotion changes. Keep tool setup and credentials in their owning plugins. Extend the existing reference only for a demonstrated failure or recurring task; do not turn this into a general video platform.
