import type { Attachment, Message } from "chat";
import * as z from "zod";
import { downloadPrivateSlackFile } from "@/chat/slack/client";

// Stored attachment ids are lowercase hex, so this never matches one.
const SLACK_FILE_ID_PATTERN = /^F[A-Z0-9]+$/;

// Read only the fields that name, type, and fetch a file. Other Slack file
// fields stay unread. A file without a private URL, such as a deleted file,
// has nothing to fetch.
export const slackMessageFileSchema = z.object({
  id: z.string().regex(SLACK_FILE_ID_PATTERN),
  mimetype: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  size: z.number().nonnegative().optional(),
  url_private: z.string().min(1),
  url_private_download: z.string().min(1).optional(),
});

/** A file of a Slack message, as Slack sends it. */
export type SlackMessageFile = z.output<typeof slackMessageFileSchema>;

/** A Slack message attachment with its Slack file id. */
export type SlackMessageAttachment = Attachment & { slackFileId?: string };

/** Report whether a value is a Slack file id, such as `F0123ABCD`. */
export function isSlackFileId(value: string): boolean {
  return SLACK_FILE_ID_PATTERN.test(value);
}

function parseFiles(value: unknown): SlackMessageFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((file) => {
    const parsed = slackMessageFileSchema.safeParse(file);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Read the files of a Slack message: its own `files`, then the files of
 * linked or forwarded messages under `attachments[].files`. Each file is
 * listed once.
 */
export function readSlackMessageFiles(message: unknown): SlackMessageFile[] {
  if (!message || typeof message !== "object") return [];
  const { attachments, files } = message as {
    attachments?: unknown;
    files?: unknown;
  };
  const nested = Array.isArray(attachments)
    ? attachments.flatMap((attachment: unknown) =>
        attachment && typeof attachment === "object"
          ? parseFiles((attachment as { files?: unknown }).files)
          : [],
      )
    : [];
  const byId = new Map<string, SlackMessageFile>();
  for (const file of [...parseFiles(files), ...nested]) {
    if (!byId.has(file.id)) byId.set(file.id, file);
  }
  return [...byId.values()];
}

/**
 * Return the download URL of a Slack file when it is on Slack's file host.
 *
 * Private file URLs get the bot token, so send it only to that host. Other
 * Slack hosts, such as the Web API, must not get it from a URL that a
 * message attachment can set.
 */
export function slackFileDownloadUrl(
  file: SlackMessageFile,
): string | undefined {
  const value = file.url_private_download ?? file.url_private;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "files.slack.com"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/** Download a Slack file with the bot token, only from Slack's file host. */
export async function downloadSlackFile(
  file: SlackMessageFile,
): Promise<Buffer> {
  const url = slackFileDownloadUrl(file);
  if (!url) {
    throw new Error(`Slack file ${file.id} is not on files.slack.com`);
  }
  return await downloadPrivateSlackFile(url);
}

function attachmentType(mimeType: string | undefined): Attachment["type"] {
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType?.startsWith("audio/")) return "audio";
  return "file";
}

/** Build the attachment of a Slack file that the Slack adapter did not map. */
export function slackFileAttachment(
  file: SlackMessageFile,
): SlackMessageAttachment {
  return {
    type: attachmentType(file.mimetype),
    url: file.url_private,
    ...(file.name ? { name: file.name } : undefined),
    ...(file.mimetype ? { mimeType: file.mimetype } : undefined),
    ...(file.size !== undefined ? { size: file.size } : undefined),
    fetchData: async () => await downloadSlackFile(file),
    slackFileId: file.id,
  };
}

/**
 * List the attachments of a Slack message, each with its Slack file id.
 *
 * The Slack adapter maps only the message's own `files`, and it drops each
 * file id. Pair those attachments with the files in `raw` by private URL, so
 * they keep the adapter's download. Add the files that the adapter does not
 * map, such as files of forwarded messages. Attachments that match no Slack
 * file keep no id.
 */
export function readSlackMessageAttachments(
  message: Pick<Message, "attachments" | "raw">,
): SlackMessageAttachment[] {
  const attachmentUrl = (attachment: Attachment) =>
    attachment.url ?? attachment.fetchMetadata?.url;
  const files = readSlackMessageFiles(message.raw);
  const fileUrls = new Set(files.map((file) => file.url_private));
  return [
    ...files.map((file) => {
      const mapped = message.attachments.find(
        (attachment) => attachmentUrl(attachment) === file.url_private,
      );
      return mapped
        ? { ...mapped, slackFileId: file.id }
        : slackFileAttachment(file);
    }),
    ...message.attachments.filter(
      (attachment) => !fileUrls.has(attachmentUrl(attachment) ?? ""),
    ),
  ];
}
