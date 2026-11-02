# Artifacts

This module owns durable objects that a Conversation owns and that Junior
makes public on purpose. Conversation attachments stay private.

- Anyone with a live public URL can fetch the artifact. Do not publish
  private content unless the Destination needs a public URL.
- A public GET serves bytes only when the `junior_artifacts` row exists,
  `public = true`, and `delete_requested_at` is null. A path or blob alone is
  never enough.
- Each artifact has its own public id. The same bytes in one Conversation
  reuse one id. Other Conversations get their own artifact and URL. Do not
  add a global content-hash URL.
- `unpublishImage` changes only an artifact that the active Conversation
  owns.
