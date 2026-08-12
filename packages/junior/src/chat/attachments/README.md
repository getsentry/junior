# Conversation attachments

This module owns durable files linked to a conversation.

- `storage.ts` defines the provider-neutral object storage capability.
- Provider adapters keep their SDK types private.
- `store.ts` writes object storage first, then creates the SQL row. A row means
  the attachment is durable.
- Attachment identity is content-stable under a conversation. The same bytes,
  filename, content type, and storage provider reuse one attachment id so
  retries do not create duplicates.
- Conversation purge marks attachments for deletion in the same SQL transaction.
- The retention job deletes object storage data outside that transaction, then
  removes the SQL rows. Failed deletion stays pending for the next run.
