# Conversation attachments

This module owns durable files linked to a conversation.

- `storage.ts` defines the provider-neutral object storage capability.
- Provider adapters keep their SDK types private.
- `store.ts` writes object storage first, then creates the SQL row. A row means
  the attachment is durable.
- Live reads load SQL metadata first, then object bytes. Missing, purge-marked,
  or purged-conversation rows return not found.
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
- Store rejects writes into a purged conversation and marks any raced insert for
  deletion before failing, so concurrent sendFiles cannot leave a durable orphan.
- Post-insert purge handling stays outside the insert cleanup catch, so a later
  non-insert error cannot delete the blob for a row that already committed.
- Reuse of another writer's live row also checks purge before reporting success.
- The retention job deletes object keys for purge-marked rows and for rows owned
  by purged conversations, then removes those SQL rows. A failed blob delete
  leaves the eligible row for the next run.

## Web image input

Web input stores image bytes before it enqueues the Message. Mailbox rows and
visible Messages keep file metadata. The host loads the bytes for model input.
Existing access, purge, and retention rules apply, including files left by a
failed send.

The 3 MB total limit leaves room for base64 and message text below the host
request limit. Draft images stay in browser memory, not localStorage.

Slack previews need both saved file ids and stored bytes. Reporting does not
fetch missing files from Slack.
