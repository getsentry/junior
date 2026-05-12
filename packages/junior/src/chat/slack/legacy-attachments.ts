/**
 * Parse and render Slack legacy attachments into text for conversation context.
 *
 * Slack "legacy attachments" are the pre-Block-Kit message enrichment format.
 * Many bots (Datadog, PagerDuty, deploy notifiers, etc.) still use them.
 * When a message carries only attachments with no top-level `text`, Junior
 * would previously see an empty message and drop it from context entirely.
 */

const MAX_ATTACHMENTS = 10;
const MAX_FIELDS_PER_ATTACHMENT = 20;
const MAX_FIELD_CHARS = 1000;
const MAX_ATTACHMENT_TEXT_CHARS = 4000;

export interface SlackLegacyAttachmentFieldRef {
  title?: string;
  value?: string;
  short?: boolean;
}

export interface SlackLegacyAttachmentRef {
  fallback?: string;
  pretext?: string;
  author_name?: string;
  title?: string;
  title_link?: string;
  text?: string;
  fields?: SlackLegacyAttachmentFieldRef[];
  footer?: string;
}

function toStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizeField(raw: unknown): SlackLegacyAttachmentFieldRef | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const title = toStr(obj.title);
  const value = toStr(obj.value)?.slice(0, MAX_FIELD_CHARS);
  if (!title && !value) return null;
  return {
    ...(title ? { title } : {}),
    ...(value ? { value } : {}),
    ...(typeof obj.short === "boolean" ? { short: obj.short } : {}),
  };
}

function sanitizeAttachment(raw: unknown): SlackLegacyAttachmentRef | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const fallback = toStr(obj.fallback);
  const pretext = toStr(obj.pretext);
  const authorName = toStr(obj.author_name);
  const title = toStr(obj.title);
  const titleLink = toStr(obj.title_link);
  const text = toStr(obj.text);
  const footer = toStr(obj.footer);

  const fields = Array.isArray(obj.fields)
    ? obj.fields
        .slice(0, MAX_FIELDS_PER_ATTACHMENT)
        .map(sanitizeField)
        .filter((f): f is SlackLegacyAttachmentFieldRef => f !== null)
    : undefined;

  if (
    !fallback &&
    !pretext &&
    !authorName &&
    !title &&
    !text &&
    !footer &&
    (!fields || fields.length === 0)
  ) {
    return null;
  }

  return {
    ...(fallback ? { fallback } : {}),
    ...(pretext ? { pretext } : {}),
    ...(authorName ? { author_name: authorName } : {}),
    ...(title ? { title } : {}),
    ...(titleLink ? { title_link: titleLink } : {}),
    ...(text ? { text } : {}),
    ...(fields && fields.length > 0 ? { fields } : {}),
    ...(footer ? { footer } : {}),
  };
}

/** Extract text-bearing fields from raw Slack legacy attachment payloads. */
export function sanitizeSlackLegacyAttachments(
  input: unknown,
): SlackLegacyAttachmentRef[] {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, MAX_ATTACHMENTS)
    .map(sanitizeAttachment)
    .filter((a): a is SlackLegacyAttachmentRef => a !== null);
}

/** Render a single attachment's text parts into a compact line. */
function renderAttachment(att: SlackLegacyAttachmentRef): string {
  const parts: string[] = [];
  const seen = new Set<string>();

  const add = (value: string | undefined) => {
    if (!value) return;
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    parts.push(normalized);
  };

  // Use fallback only if no richer fields exist
  const hasRichContent = att.pretext || att.title || att.text;

  if (!hasRichContent) {
    add(att.fallback);
  }
  add(att.pretext);
  if (att.author_name) add(att.author_name);
  if (att.title && att.title_link) {
    add(`${att.title} (${att.title_link})`);
  } else {
    add(att.title);
  }
  add(att.text);

  if (att.fields) {
    for (const field of att.fields) {
      if (field.title && field.value) {
        add(`${field.title}: ${field.value}`);
      } else {
        add(field.title || field.value);
      }
    }
  }

  add(att.footer);

  return parts.join(" | ");
}

/** Render Slack legacy attachments as readable text for conversation context. */
export function renderSlackLegacyAttachmentText(input: unknown): string {
  const attachments = sanitizeSlackLegacyAttachments(input);
  if (attachments.length === 0) return "";

  const rendered = attachments
    .map(renderAttachment)
    .filter((line) => line.length > 0)
    .map((line) => `[attachment] ${line}`)
    .join("\n");

  return rendered.slice(0, MAX_ATTACHMENT_TEXT_CHARS);
}

/** Combine message text with any legacy attachment text, returning enriched text. */
export function appendSlackLegacyAttachmentText(
  baseText: string | undefined,
  rawAttachments: unknown,
): string {
  const base = baseText?.trim() ?? "";
  const attachmentText = renderSlackLegacyAttachmentText(rawAttachments);
  if (!attachmentText) return base;
  if (!base) return attachmentText;
  return `${base}\n${attachmentText}`;
}
