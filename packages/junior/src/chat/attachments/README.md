# Conversation attachments

This module owns durable files linked to a conversation.

- `storage.ts` defines the provider-neutral object storage capability.
- Provider adapters keep their SDK types private.
- `store.ts` writes object storage first, then creates the SQL row. A row means
  the attachment is durable.
- Attachment identity is content-stable under a conversation. The same bytes,
  filename, content type, and storage provider reuse one attachment id so
  retries do not create duplicates.
- Object keys are unique per write attempt. Failed-write cleanup and GC delete
  only that write's object, so they cannot remove another writer's durable blob.
- A purge-marked row is revived by writing a new object and pointing the row at
  it, then deleting the old object.
- If the SQL write fails after object storage accepts the bytes, the store path
  deletes that unique object. A process crash between those steps can leave an
  unreferenced unique object with no SQL row.
- Conversation purge marks attachments for deletion in the same SQL transaction.
- The retention job removes still-marked SQL rows, then deletes those rows'
  object keys.
