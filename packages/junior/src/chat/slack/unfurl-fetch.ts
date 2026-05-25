import { listThreadReplies } from "@/chat/slack/channel";
import { renderSlackLegacyAttachmentText } from "@/chat/slack/legacy-attachments";

const URL_PATTERN = /\bhttps?:\/\/\S+/i;

/** Return true when the raw message object already carries attachment data. */
function hasAttachments(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const attachments = (raw as Record<string, unknown>).attachments;
  return Array.isArray(attachments) && attachments.length > 0;
}

/** Return true when the text contains at least one URL that Slack might unfurl. */
function containsUrl(text: string | undefined): boolean {
  return URL_PATTERN.test(text ?? "");
}

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempt to enrich the raw message object with Slack unfurl attachment data
 * fetched from the Slack API.
 *
 * Slack delivers unfurls asynchronously via `message_changed` events, so the
 * original inbound `message.raw` often has an empty `attachments` array even
 * when a URL preview is already visible in the Slack UI. This helper retries
 * the `conversations.replies` endpoint a few times with short delays so that
 * Junior can see unfurl content when constructing the user turn text.
 *
 * @returns The original `raw` object when no enrichment is needed or possible;
 *   otherwise a shallow copy of `raw` with `attachments` from the API response.
 */
export async function maybeRefetchSlackUnfurlAttachments(input: {
  channelId: string | undefined;
  threadTs: string | undefined;
  messageTs: string | undefined;
  originalRaw: unknown;
  text: string | undefined;
}): Promise<unknown> {
  const { channelId, threadTs, messageTs, originalRaw, text } = input;

  // Skip: already has attachment data.
  if (hasAttachments(originalRaw)) {
    return originalRaw;
  }

  // Skip: no URLs means Slack won't generate unfurls.
  if (!containsUrl(text)) {
    return originalRaw;
  }

  // Skip: missing identifiers needed for the API call.
  if (!channelId || !messageTs) {
    return originalRaw;
  }

  const resolvedThreadTs = threadTs ?? messageTs;

  // Retry with short delays — Slack generates most unfurls within 1–2 s.
  const delaysMs = [400, 800, 1300];

  for (const delayMs of delaysMs) {
    await sleep(delayMs);

    let replies: Awaited<ReturnType<typeof listThreadReplies>>;
    try {
      replies = await listThreadReplies({
        channelId,
        threadTs: resolvedThreadTs,
        targetMessageTs: [messageTs],
        limit: 1,
        maxPages: 1,
      });
    } catch {
      // Best-effort; a single failed attempt should not block the turn.
      break;
    }

    const matched = replies.find((r) => r.ts === messageTs);
    if (matched?.attachments?.length) {
      const rendered = renderSlackLegacyAttachmentText(matched.attachments);
      if (rendered) {
        // Merge fetched attachments into the original raw shape so that
        // appendSlackLegacyAttachmentText and other consumers work unchanged.
        return {
          ...(originalRaw && typeof originalRaw === "object"
            ? originalRaw
            : {}),
          attachments: matched.attachments,
        };
      }
    }
  }

  return originalRaw;
}
