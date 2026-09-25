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

The web composer accepts PNG, JPEG, GIF, and WebP images by paste, drop, or
file selection. It sends image bytes with the message request. The request
accepts up to three images with a total of 3 MB. This leaves space for base64
and message text below the host request limit. Draft images stay in browser
memory, not localStorage. A failed send retains them for retry.

Web input creates the Conversation root, stores the files, then enqueues the
Message. The mailbox and visible Message keep attachment metadata, not bytes.
The host loads stored images into native model image parts. The existing
attachment store owns access, idempotent writes, purge, and 30-day retention.
A failed send can leave stored files without a Message; retention removes them.

Reporting resolves Slack file ids to the same private attachment read route.
New Slack Messages keep file ids at ingestion. Older Messages can render images
when their saved metadata includes file ids and the bytes are still stored.
Files that Junior never stored cannot be recovered by reporting.
