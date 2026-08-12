# Conversation attachments

This module owns durable files linked to a conversation.

- `storage.ts` defines the provider-neutral object storage capability.
- Provider adapters keep their SDK types private.
- `store.ts` writes SQL metadata before object storage and marks the row ready after upload.
- A retry uses the same conversation, tool call, and position. It reuses the row only when the provider and file metadata match.
- Conversation purge marks attachments for deletion in the same SQL transaction.
- The retention job deletes object storage data outside that transaction, then removes the SQL rows. Failed deletion stays pending for the next run.
- A pending write older than 24 hours is garbage collection work.
