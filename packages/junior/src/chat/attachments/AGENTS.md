# Conversation Attachments

- Runtime code calls `getAttachmentStorage()` and does not choose a provider.
  Only adapter tests call `createAttachmentStorage`.
- Write the object first, then the SQL row. A row means the attachment is
  durable.
- Cleanup deletes only the object of its own write attempt, never another
  writer's blob.
- Keep post-insert purge handling outside the insert cleanup catch. A later
  error must not delete the blob of a committed row.
- Live reads load SQL first.
- Web input stores image bytes before it enqueues the Message. Mailbox rows
  and Messages keep only file metadata.
- Reporting does not fetch missing files from Slack.
