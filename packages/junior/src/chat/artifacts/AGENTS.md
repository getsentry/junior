# Artifacts

Durable objects that a Conversation owns and that Junior makes public on
purpose. Conversation attachments stay private.

- Anyone with a live public URL can fetch the artifact. Publish private
  content only when the Destination needs a public URL.
- A public GET serves bytes only when the `junior_artifacts` row exists,
  `public = true`, and `delete_requested_at` is null. A path or blob alone is
  never enough.
- The same bytes in one Conversation reuse one public id. Other Conversations
  get their own artifact and URL. No global content-hash URL.
- `unpublishImage` changes only an artifact that the active Conversation
  owns.
