import type { SlackAdapter, SlackEvent } from "@chat-adapter/slack";
import type { Message } from "chat";
import { logWarn } from "@/chat/logging";
import { readSlackMessage } from "@/chat/slack/channel";
import { parseSlackChannelId } from "@/chat/slack/ids";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";
import { sleep } from "@/chat/sleep";

// Slack attached linked files 0.3-1.5 s after the message events in observed
// threads. Wait at most about 3 s.
const READ_DELAYS_MS = [0, 1_000, 2_000];

function collectFileElementIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectFileElementIds(item, ids);
    return;
  }
  if (!value || typeof value !== "object") return;
  const element = value as { elements?: unknown; file_id?: unknown };
  if ("type" in element && element.type === "file") {
    if (typeof element.file_id === "string") ids.add(element.file_id);
    return;
  }
  collectFileElementIds(element.elements, ids);
}

function missingLinkedFileIds(raw: SlackEvent): Set<string> {
  const ids = new Set<string>();
  collectFileElementIds(raw.blocks, ids);
  for (const file of raw.files ?? []) {
    if (file.id) ids.delete(file.id);
  }
  return ids;
}

/**
 * Add the files that a person linked in a Slack message to its attachments.
 *
 * When a person pastes a link to an existing Slack file, the message events
 * have the file only as a rich text `file` element. Slack attaches the file
 * later with a `message_changed` event, and ingress ignores that event so that
 * accepted Messages do not change. Read the message again to get the files
 * that Slack attached.
 */
export async function attachLinkedSlackFiles(args: {
  adapter: SlackAdapter;
  message: Message;
}): Promise<void> {
  const raw = args.message.raw as SlackEvent;
  const missing = missingLinkedFileIds(raw);
  const channelId = parseSlackChannelId(raw.channel);
  const ts = parseSlackMessageTs(raw.ts);
  if (missing.size === 0 || !channelId || !ts) return;
  const threadTs = parseSlackMessageTs(raw.thread_ts) ?? ts;

  // Each read returns the full message, so keep only the latest files.
  let files: NonNullable<SlackEvent["files"]> = [];
  try {
    for (const delayMs of READ_DELAYS_MS) {
      await sleep(delayMs);
      const message = await readSlackMessage({ channelId, threadTs, ts });
      files = (message?.files ?? [])
        .filter((file) => file.id && missing.has(file.id))
        .map((file) => ({
          id: file.id,
          mimetype: file.mimetype,
          name: file.name,
          size: file.size,
          url_private: file.url_private,
        }));
      if (files.length === missing.size) break;
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
  if (files.length < missing.size) {
    logWarn("slack.linked_file.missing", {
      "messaging.message.id": ts,
      "app.slack.linked_file.count": missing.size,
      "app.slack.linked_file.missing.count": missing.size - files.length,
    });
  }
  if (files.length > 0) {
    args.message.attachments.push(
      ...args.adapter.parseMessage({ ...raw, files }).attachments,
    );
  }
}
