import type { SlackAdapter, SlackEvent } from "@chat-adapter/slack";
import type { Message } from "chat";
import { logWarn } from "@/chat/logging";
import { readSlackMessage, type SlackFileRef } from "@/chat/slack/channel";
import { parseSlackChannelId } from "@/chat/slack/ids";
import {
  extractAttachmentFiles,
  toFileRef,
} from "@/chat/slack/message/attachments";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";
import { sleep } from "@/chat/sleep";

// Slack attached linked files 0.3-1.5 s after the message events in observed
// threads. Wait at most about 3 s.
const READ_DELAYS_MS = [0, 1_000, 2_000];
const SLACK_MESSAGE_LINK_PATTERN =
  /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:[/?#]|$)/;

interface LinkedTargets {
  fileIds: Set<string>;
  messageLinks: Set<string>;
}

interface LinkedMessage {
  attachments?: unknown;
  files?: unknown;
}

function messageLinkKey(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const match = url.match(SLACK_MESSAGE_LINK_PATTERN);
  return match ? `${match[1]}/${match[2]}.${match[3]}` : undefined;
}

function collectTargets(value: unknown, targets: LinkedTargets): void {
  if (Array.isArray(value)) {
    for (const item of value) collectTargets(item, targets);
    return;
  }
  if (!value || typeof value !== "object") return;
  const element = value as {
    elements?: unknown;
    file_id?: unknown;
    type?: unknown;
    url?: unknown;
  };
  if (element.type === "file" && typeof element.file_id === "string") {
    targets.fileIds.add(element.file_id);
    return;
  }
  if (element.type === "link") {
    const key = messageLinkKey(element.url);
    if (key) targets.messageLinks.add(key);
    return;
  }
  collectTargets(element.elements, targets);
}

// Pasted file links arrive in `files`. Links to another Slack message arrive
// as a message unfurl in `attachments`, with the files of that message in
// `attachments[].files`.
function findLinkedFiles(
  message: LinkedMessage,
  targets: LinkedTargets,
): { complete: boolean; files: SlackFileRef[] } {
  const files = new Map<string, SlackFileRef>();
  for (const rawFile of Array.isArray(message.files) ? message.files : []) {
    const file = toFileRef(rawFile);
    if (file?.id && targets.fileIds.has(file.id)) files.set(file.id, file);
  }
  const unfurled = new Set<string>();
  const attachments = Array.isArray(message.attachments)
    ? message.attachments
    : [];
  for (const attachment of attachments) {
    const { from_url, original_url } = (attachment ?? {}) as {
      from_url?: unknown;
      original_url?: unknown;
    };
    const key = messageLinkKey(from_url) ?? messageLinkKey(original_url);
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
 * A pasted link to an existing Slack file reaches Junior only as a rich text
 * `file` element. A link to another Slack message reaches Junior only as a
 * rich text `link` element. Slack adds the files, or the message unfurl with
 * its files, later with a `message_changed` event, and ingress ignores that
 * event so that accepted Messages do not change. Read the message again to
 * get the files that Slack attached.
 */
export async function attachLinkedSlackFiles(args: {
  adapter: SlackAdapter;
  message: Message;
}): Promise<void> {
  const raw = args.message.raw as SlackEvent;
  const targets: LinkedTargets = {
    fileIds: new Set(),
    messageLinks: new Set(),
  };
  collectTargets(raw.blocks, targets);
  for (const file of raw.files ?? []) {
    if (file.id) targets.fileIds.delete(file.id);
  }
  const channelId = parseSlackChannelId(raw.channel);
  const ts = parseSlackMessageTs(raw.ts);
  if (targets.fileIds.size + targets.messageLinks.size === 0) return;
  if (!channelId || !ts) return;
  const threadTs = parseSlackMessageTs(raw.thread_ts) ?? ts;

  // Each read returns the full message, so keep only the latest files.
  let found = findLinkedFiles(raw, targets);
  try {
    for (const delayMs of READ_DELAYS_MS) {
      if (found.complete) break;
      await sleep(delayMs);
      const message = await readSlackMessage({ channelId, threadTs, ts });
      if (message) found = findLinkedFiles(message, targets);
    }
  } catch (error) {
    // Linked files are optional input. The turn runs without them, the same
    // as before Junior read them, instead of failing on a Slack read error.
    logWarn("slack.linked_file.read.failed", {
      "messaging.message.id": ts,
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
  }
  if (!found.complete) {
    logWarn("slack.linked_file.missing", {
      "messaging.message.id": ts,
      "app.slack.linked_file.count": targets.fileIds.size,
      "app.slack.linked_message.count": targets.messageLinks.size,
      "app.slack.linked_file.found.count": found.files.length,
    });
  }
  if (found.files.length > 0) {
    args.message.attachments.push(
      ...args.adapter.parseMessage({
        ...raw,
        files: found.files as SlackEvent["files"],
      }).attachments,
    );
  }
}
