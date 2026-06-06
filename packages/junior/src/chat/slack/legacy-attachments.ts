const MAX_ATTACHMENTS = 10;
const MAX_FIELDS_PER_ATTACHMENT = 20;
const MAX_FIELD_CHARS = 1000;
const MAX_ATTACHMENT_TEXT_CHARS = 4000;

function toStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

  const add = (value: string | undefined) => {
    if (!value) return;
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    parts.push(normalized);
  };

  const hasRichContent = pretext || title || text;
  if (!hasRichContent) {
    add(fallback);
  }
  add(pretext);
  add(authorName);
  if (title && titleLink) {
    add(`${title} (${titleLink})`);
    seen.add(title.trim());
  } else {
    add(title);
  }
  add(text);

  for (const field of fields.slice(0, MAX_FIELDS_PER_ATTACHMENT)) {
    add(renderField(field));
  }

  add(footer);

  return parts.join(" | ");
}

/** Render legacy Slack attachment fields so attachment-only messages still carry context. */
export function renderSlackLegacyAttachmentText(input: unknown): string {
  const rendered = getAttachmentPayload(input)
    .slice(0, MAX_ATTACHMENTS)
    .map(renderAttachment)
    .filter((line) => line.length > 0)
    .map((line) => `[attachment] ${line}`)
    .join("\n");

  return rendered.slice(0, MAX_ATTACHMENT_TEXT_CHARS);
}

/** Append legacy Slack attachment text to the message text used by routing and replies. */
export function appendSlackLegacyAttachmentText(
  baseText: string | undefined,
  rawMessageOrAttachments: unknown,
): string {
  const base = baseText?.trim() ?? "";
  const attachmentText = renderSlackLegacyAttachmentText(
    rawMessageOrAttachments,
  );
  if (!attachmentText) return base;
  if (!base) return attachmentText;
  return `${base}\n${attachmentText}`;
}
