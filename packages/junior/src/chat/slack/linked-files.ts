import type { SlackAdapter } from "@chat-adapter/slack";
import type { Message } from "chat";
import * as z from "zod";
import { slackEventSchema } from "@/chat/ingress/slack-payload";
import { logWarn } from "@/chat/logging";
import { getChannelMessage, type SlackFileRef } from "@/chat/slack/channel";
import { parseSlackChannelId } from "@/chat/slack/ids";
import {
  extractAttachmentFiles,
  toFileRef,
} from "@/chat/slack/message/attachments";
import { parseSlackMessageReference } from "@/chat/slack/tool-support/slack-message-url";
import { sleep } from "@/chat/sleep";

// Slack attached linked files 0.3-1.5 s after the message events in observed
// threads. Wait at most about 3 s.
const READ_DELAYS_MS = [0, 1_000, 2_000];

// Rich text nests sections, lists, and quotes, so walk `elements` at any depth.
const richTextElementSchema = z.looseObject({
  elements: z.array(z.unknown()).optional(),
  file_id: z.string().optional(),
  type: z.string().optional(),
  url: z.string().optional(),
});

const unfurlSchema = z.looseObject({
  from_url: z.string().optional(),
  original_url: z.string().optional(),
});

interface LinkedTargets {
  fileIds: Set<string>;
  messageLinks: Set<string>;
}

interface LinkedMessage {
  attachments?: unknown[] | undefined;
  files?: unknown[] | undefined;
}

function messageLinkKey(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const parsed = parseSlackMessageReference(url);
  return parsed.ok
    ? `${parsed.reference.channelId}/${parsed.reference.messageTs}`
    : undefined;
}

function collectTargets(values: unknown[], targets: LinkedTargets): void {
  for (const value of values) {
    const element = richTextElementSchema.safeParse(value);
    if (!element.success) continue;
    const { elements, file_id: fileId, type, url } = element.data;
    if (type === "file" && fileId) {
      targets.fileIds.add(fileId);
    } else if (type === "link") {
      const key = messageLinkKey(url);
      if (key) targets.messageLinks.add(key);
    } else if (elements) {
      collectTargets(elements, targets);
    }
  }
}

// Pasted file links arrive in `files`. Links to another Slack message arrive
// as a message unfurl in `attachments`, with the files of that message in
// `attachments[].files`.
function findLinkedFiles(
  message: LinkedMessage,
  targets: LinkedTargets,
): { complete: boolean; files: SlackFileRef[] } {
  const files = new Map<string, SlackFileRef>();
  for (const rawFile of message.files ?? []) {
    const file = toFileRef(rawFile);
    if (file?.id && targets.fileIds.has(file.id)) files.set(file.id, file);
  }
  const unfurled = new Set<string>();
  for (const attachment of message.attachments ?? []) {
    const unfurl = unfurlSchema.safeParse(attachment);
    if (!unfurl.success) continue;
    const key =
      messageLinkKey(unfurl.data.from_url) ??
      messageLinkKey(unfurl.data.original_url);
    if (!key || !targets.messageLinks.has(key)) continue;
    unfurled.add(key);
    for (const file of extractAttachmentFiles([attachment])) {
      if (file.id) files.set(file.id, file);
    }
  }
  const complete =
    [...targets.fileIds].every((id) => files.has(id)) &&
    unfurled.size === targets.messageLinks.size;
  return { complete, files: [...files.values()] };
}

/**
 * Add the files that a person linked in a Slack message to its attachments.
 *
 * Slack adds a pasted file, or the unfurl of a linked message, after the
 * message events. Ingress drops that `message_changed`, so read it again.
 */
export async function attachLinkedSlackFiles(args: {
  adapter: SlackAdapter;
  message: Message;
}): Promise<void> {
  const parsed = slackEventSchema.safeParse(args.message.raw);
  if (!parsed.success) return;
  const raw = parsed.data;
  const targets: LinkedTargets = {
    fileIds: new Set(),
    messageLinks: new Set(),
  };
  collectTargets(raw.blocks ?? [], targets);
  for (const file of raw.files ?? []) {
    if (file.id) targets.fileIds.delete(file.id);
  }
  const channelId = parseSlackChannelId(raw.channel);
  const messageTs = raw.ts;
  if (targets.fileIds.size + targets.messageLinks.size === 0) return;
  if (!channelId || !messageTs) return;

  // Each read returns the full message, so keep only the latest files.
  let found = findLinkedFiles(raw, targets);
  try {
    /* oxlint-disable no-await-in-loop -- Each read waits for Slack to attach more. */
    for (const delayMs of READ_DELAYS_MS) {
      if (found.complete) break;
      await sleep(delayMs);
      const message = await getChannelMessage({
        channelId,
        messageTs,
        threadTs: raw.thread_ts,
      });
      if (message) found = findLinkedFiles(message, targets);
    }
    /* oxlint-enable no-await-in-loop */
  } catch (error) {
    // Linked files are optional input. The turn runs without them, the same
    // as before Junior read them, instead of failing on a Slack read error.
    logWarn("slack.linked_file.read.failed", {
      "messaging.message.id": messageTs,
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
  }
  if (!found.complete) {
    logWarn("slack.linked_file.missing", {
      "messaging.message.id": messageTs,
      "app.slack.linked_file.count": targets.fileIds.size,
      "app.slack.linked_message.count": targets.messageLinks.size,
      "app.slack.linked_file.found.count": found.files.length,
    });
  }
  if (found.files.length > 0) {
    const files = found.files.map(
      ({ id, mimetype, name, size, url_private }) => ({
        id,
        mimetype,
        name,
        size,
        url_private,
      }),
    );
    args.message.attachments.push(
      ...args.adapter.parseMessage({ ...raw, files }).attachments,
    );
  }
}
