import { renderBlockText } from "@/chat/slack/message/blocks";
import type { SlackFileRef } from "@/chat/slack/channel";

const MAX_ATTACHMENTS = 10;
const MAX_FIELDS_PER_ATTACHMENT = 20;
const MAX_FIELD_CHARS = 1000;
const MAX_ATTACHMENT_TEXT_CHARS = 4000;

function toStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toNum(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function toFileRef(raw: unknown): SlackFileRef | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const id = toStr(obj.id);
  if (!id) return undefined;
  return {
    id,
    name: toStr(obj.name),
    mimetype: toStr(obj.mimetype),
    size: toNum(obj.size),
    url_private: toStr(obj.url_private),
    url_private_download: toStr(obj.url_private_download),
  };
}

/**
 * Extract files nested inside legacy Slack `attachments` payloads.
 *
 * Forwarded/shared messages carry their original files under
 * `attachments[].files` instead of the top-level `files` array, so
 * callers that only read `message.files` silently drop them.
 */
export function extractAttachmentFiles(input: unknown): SlackFileRef[] {
  const files: SlackFileRef[] = [];
  const seen = new Set<string>();

  for (const attachment of getAttachmentPayload(input)) {
    if (!attachment || typeof attachment !== "object") continue;
    const rawFiles = (attachment as Record<string, unknown>).files;
    if (!Array.isArray(rawFiles)) continue;
    for (const rawFile of rawFiles) {
      const fileRef = toFileRef(rawFile);
      if (!fileRef?.id || seen.has(fileRef.id)) continue;
      seen.add(fileRef.id);
      files.push(fileRef);
    }
  }

  return files;
}

function getAttachmentPayload(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== "object") return [];
  const attachments = (input as Record<string, unknown>).attachments;
  return Array.isArray(attachments) ? attachments : [];
}

function renderField(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const title = toStr(obj.title);
  const value = toStr(obj.value)?.slice(0, MAX_FIELD_CHARS);
  if (title && value) return `${title}: ${value}`;
  return title || value;
}

function normalizeAttachmentText(value: string): string {
  // Slack unfurl attachments often collapse intentional line breaks. Restore
  // the common shapes so durable transcripts keep readable multi-line lists:
  // - paragraph breaks before a list ("out.  - item")
  // - single spaces between markdown-ish list items ("- **a:** x - **b:** y")
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/ {2,}(?=[-*+]\s|\d+\.\s)/g, "\n")
    .replace(/(?<=\S) (?=[-*+] \*\*[^*\n]+\*\*)/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderAttachment(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const obj = raw as Record<string, unknown>;
  const parts: string[] = [];
  const seen = new Set<string>();

  const fallback = toStr(obj.fallback);
  const pretext = toStr(obj.pretext);
  const authorName = toStr(obj.author_name);
  const title = toStr(obj.title);
  const titleLink = toStr(obj.title_link);
  const text = toStr(obj.text);
  const footer = toStr(obj.footer);
  const fields = Array.isArray(obj.fields) ? obj.fields : [];
  const blockText = renderBlockText(obj.blocks);

  const add = (value: string | undefined) => {
    if (!value) return;
    const normalized = normalizeAttachmentText(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    parts.push(normalized);
  };

  const hasRichContent = pretext || title || text || blockText;
  if (!hasRichContent) {
    add(fallback);
  }
  add(pretext);
  add(authorName);
  if (title && titleLink) {
    add(`${title} (${titleLink})`);
    seen.add(normalizeAttachmentText(title));
  } else {
    add(title);
  }
  add(text);

  for (const field of fields.slice(0, MAX_FIELDS_PER_ATTACHMENT)) {
    add(renderField(field));
  }

  add(blockText);
  add(footer);

  // Keep multi-line bodies readable. Compact single-line attachments still
  // collapse cleanly onto one line via the final trim.
  return parts.join("\n");
}

/** Render legacy attachment fields so attachment-only messages still carry context. */
export function renderAttachmentText(input: unknown): string {
  const rendered = getAttachmentPayload(input)
    .slice(0, MAX_ATTACHMENTS)
    .map(renderAttachment)
    .filter((line) => line.length > 0)
    .map((line) => `[attachment] ${line}`)
    .join("\n");

  return rendered.slice(0, MAX_ATTACHMENT_TEXT_CHARS);
}
