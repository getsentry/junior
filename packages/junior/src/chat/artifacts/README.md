# Artifacts

This module owns durable content-addressed objects Junior may intentionally make
public.

- SQL metadata lives in `junior_artifacts`.
- Object bytes live under `artifacts/<sha256>.<ext>` in attachment object storage.
- Public reads are unauthenticated at `/public/artifacts/<sha256>.<ext>`.
- A public GET serves bytes only when the row exists, `public = true`, and
  `delete_requested_at` is null. Path/blob alone is never enough.
- `publishImage` is the first writer. It validates image bytes, puts the object,
  and upserts a public row (`public = true`, `delete_requested_at = null`).
- `unpublishImage` sets `delete_requested_at`. Republish of the same bytes is
  allowed and clears the tombstone.
- Conversation attachments stay private and conversation-scoped.

Anyone with a live public URL can fetch the artifact. Do not publish private
content unless the destination requires a public URL.
