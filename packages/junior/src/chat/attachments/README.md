# Conversation attachments

This module owns durable files linked to a conversation.

- `storage.ts` defines the provider-neutral object storage capability.
- Provider adapters keep their SDK types private.
- `store.ts` creates one conversation-owned attachment id per file, writes SQL
  metadata before object storage, and marks the row ready after upload.
- Attachment identity is the attachment id under a conversation. It is not tied
  to tool calls, so later sources such as user uploads can reuse the same table.
- Conversation purge marks attachments for deletion in the same SQL transaction.
- The retention job deletes object storage data outside that transaction, then
  removes the SQL rows. Failed deletion stays pending for the next run.
- A pending write older than 24 hours is garbage collection work.
