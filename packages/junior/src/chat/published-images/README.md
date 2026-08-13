# Published images

This module owns durable image objects that Junior intentionally makes public.

- Objects are separate from conversation attachments.
- Identity is content-addressed under `published-images/<sha256>.<ext>`.
- Writes happen only through the internal publish path.
- Reads are unauthenticated at `/public/images/<sha256>.<ext>`.
- Anyone with the URL can fetch the image. Do not publish private content unless
  the destination requires a public image URL.

Conversation attachments stay private and conversation-scoped. Published images
exist so destinations such as GitHub comments can embed a durable HTTPS image.
