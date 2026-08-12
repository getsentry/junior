# Conversation attachments

This module owns durable files linked to a conversation.

- `storage.ts` defines the provider-neutral object storage capability.
- Provider adapters keep their SDK types private.
- `store.ts` writes object storage first, then creates the SQL row. A row means
  the attachment is durable.
- Attachment identity is content-stable under a conversation. The same bytes,
  filename, content type, and storage provider reuse one attachment id so
  retries do not create duplicates.
- A purge-marked row is revived by rewriting the blob and clearing the mark, so
  a later store of the same file does not reuse a doomed attachment.
- If the SQL write fails after object storage accepts the bytes, the store path
  deletes that blob. A process crash between those steps can leave an
  unreferenced blob on a stable key; the next store of the same content
  overwrites it.
- Conversation purge marks attachments for deletion in the same SQL transaction.
- The retention job removes still-marked SQL rows first, then deletes object
  keys that were not reclaimed by a concurrent revive. Failed object deletion
  stays pending only while the SQL row remains marked; after the row is gone,
  the next store of the same content overwrites any leftover blob.
