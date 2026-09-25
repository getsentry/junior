# Artifacts

This module owns durable conversation-owned objects Junior may intentionally
make public.

- SQL metadata lives in `junior_artifacts`.
- Each artifact has its own public id. Conversations do not share one global
  content-hash URL.
- Object bytes live under `artifacts/<id>.<ext>` in attachment object storage.
- Public reads are unauthenticated at `/public/artifacts/<id>.<ext>`.
- A public GET serves bytes only when the row exists, `public = true`, and
  `delete_requested_at` is null. Path/blob alone is never enough.
- `publishImage` validates image bytes, puts the object, and inserts or updates
  the active conversation's row for those bytes
  (`public = true`, `delete_requested_at = null`).
- Within one conversation, the same image bytes reuse one artifact id.
- Across conversations, the same image bytes get independent artifacts and URLs.
- `unpublishImage` sets `delete_requested_at` only for an artifact owned by the
  active conversation.
- Conversation attachments stay private and conversation-scoped.

Anyone with a live public URL can fetch the artifact. Do not publish private
content unless the destination requires a public URL.
