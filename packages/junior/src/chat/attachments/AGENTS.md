# Conversation Attachments

Durable files that belong to a Conversation, private and scoped to it. Public
files are in `chat/artifacts/`.

## Storage

- Runtime code calls `getAttachmentStorage()` in `storage.ts` and does not
  choose a provider. Only adapter tests call `createAttachmentStorage`.
- Each provider module (`vercel.ts`, `s3.ts`, `memory.ts`) owns its settings
  and keeps SDK types private.

## Write And Purge

- `store.ts` writes the object first, then the SQL row. A row means the
  attachment is durable.
- The same bytes, filename, content type, and provider reuse one attachment
  id, so retries make no duplicates.
- Object keys are unique per write attempt. Cleanup deletes only the object of
  its own write, never another writer's blob.
- Store rejects writes into a purged Conversation. It marks a raced insert for
  deletion before it fails, so concurrent sends leave no durable orphan.
- Keep post-insert purge handling outside the insert cleanup catch. A later
  error must not delete the blob of a committed row.
- Reuse of another writer's live row also checks purge.
- Conversation purge marks attachments in the same SQL transaction. The
  retention job deletes the objects, then the rows. A failed blob delete
  leaves the row for the next run.
- Live reads load SQL first. Missing, purge-marked, or purged-Conversation
  rows return not found.

## Input And Output

- `sendFiles` in web-only Conversations stores files under the Conversation's
  access and retention rules. It creates no public URLs.
- Web input stores image bytes before it enqueues the Message. Mailbox rows
  and Messages keep only file metadata.
- Reporting does not fetch missing files from Slack.
