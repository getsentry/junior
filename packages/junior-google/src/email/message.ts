/**
 * Turn one Gmail message into an email request, or say why Junior drops it.
 *
 * Junior trusts an email only when Google's own receiving server says that
 * DMARC passed for the domain in `From`, and that domain is allowed. The
 * caller must still match the sender to a known User. Text that the sender
 * quoted or forwarded is kept apart, because other people wrote it.
 */
import * as z from "zod";
import { emailDomain } from "../config";
import type { GmailMessage, GmailPart } from "./gmail";

/** Most characters of the sender's own words that reach the agent. */
const MAX_SENDER_TEXT = 8_000;
/** Most characters of quoted or forwarded text that reach the agent. */
const MAX_QUOTED_TEXT = 16_000;

/** Google's receiving server. Only its Authentication-Results count. */
const GOOGLE_AUTHSERV_ID = "mx.google.com";

/**
 * Lines that start text which the sender did not write in this message:
 * forwards, reply attributions (Gmail can wrap them over two lines), Outlook
 * originals, and `>` quotes.
 */
const QUOTE_STARTS = [
  /^-{2,} ?Forwarded message ?-{2,}$/im,
  /^Begin forwarded message:$/im,
  /^On [^\n]{1,300}(?:\n[^\n]{1,300})?wrote:$/m,
  /^-{2,} ?Original Message ?-{2,}$/im,
  /^>/m,
];

/** Why Junior did not turn an email into a request. */
type EmailDropReason =
  | "automated"
  | "calendar_reply"
  | "from_junior"
  | "invalid_sender"
  | "no_text"
  | "outside_domain"
  | "unauthenticated";

/** An email that Junior verified, split into the sender's words and the rest. */
export interface EmailRequest {
  cc: string[];
  messageId: string;
  /** Text that the sender quoted or forwarded. Other people may have written it. */
  quotedText: string;
  sender: { email: string; name?: string };
  /** What the sender wrote in this message. */
  senderText: string;
  sentAt?: string;
  subject: string;
  threadId: string;
  to: string[];
}

function headerValues(part: GmailPart, name: string): string[] {
  const lower = name.toLowerCase();
  return (part.headers ?? [])
    .filter((header) => header.name.toLowerCase() === lower)
    .map((header) => header.value);
}

function header(part: GmailPart, name: string): string | undefined {
  return headerValues(part, name)[0]?.trim() || undefined;
}

const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(320));

/** Read the one mailbox in a `From` header. Reject a group or a list. */
function parseSender(
  value: string | undefined,
): EmailRequest["sender"] | undefined {
  if (!value) return undefined;
  const angle = value.match(/^(.*)<([^<>]+)>\s*$/s);
  const rawName = angle?.[1] ?? "";
  // A second mailbox outside a quoted display name means a list.
  if (/[<>,;]/.test(rawName.replace(/"(?:[^"\\]|\\.)*"/g, ""))) {
    return undefined;
  }
  const address = emailSchema.safeParse(angle ? angle[2] : value);
  if (!address.success) return undefined;
  const name = rawName
    .trim()
    .replace(/^"(.*)"$/s, "$1")
    .trim();
  return { email: address.data, ...(name ? { name } : undefined) };
}

function addresses(value: string | undefined): string[] {
  const found = value?.match(/[^\s<>,;"']+@[^\s<>,;"']+/g) ?? [];
  return [
    ...new Set(
      found.flatMap((item) => {
        const parsed = emailSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when the newest Authentication-Results header comes from Google and
 * says that DMARC passed for the `From` domain. A sender can add their own
 * Authentication-Results headers, but Google adds its header above them.
 */
function dmarcPassed(payload: GmailPart, fromDomain: string): boolean {
  const newest = headerValues(payload, "Authentication-Results")[0];
  if (!newest) return false;
  const [authservId, ...results] = newest.split(";").map((item) => item.trim());
  if (authservId?.toLowerCase() !== GOOGLE_AUTHSERV_ID) return false;
  const headerFrom = new RegExp(
    `\\bheader\\.from=${escapeRegExp(fromDomain)}(?:\\s|$)`,
    "i",
  );
  return results.some(
    (result) => /^dmarc=pass\b/i.test(result) && headerFrom.test(result),
  );
}

/** True for auto-replies, mailing lists, and other bulk mail (RFC 3834). */
function isAutomated(payload: GmailPart): boolean {
  const autoSubmitted = header(payload, "Auto-Submitted")?.toLowerCase();
  const precedence = header(payload, "Precedence")?.toLowerCase();
  return (
    (autoSubmitted !== undefined && autoSubmitted !== "no") ||
    precedence === "bulk" ||
    precedence === "junk" ||
    precedence === "list" ||
    header(payload, "List-Id") !== undefined
  );
}

function allParts(part: GmailPart): GmailPart[] {
  return [part, ...(part.parts ?? []).flatMap(allParts)];
}

/** Read the first plain-text body part that is not an attachment. */
function plainText(payload: GmailPart): string | undefined {
  const part = allParts(payload).find(
    (item) =>
      item.mimeType?.toLowerCase() === "text/plain" &&
      !item.filename &&
      item.body?.data,
  );
  return part?.body?.data
    ? Buffer.from(part.body.data, "base64url").toString("utf8")
    : undefined;
}

/** Split a plain-text body at the first line that starts quoted text. */
function splitQuoted(text: string): { quoted: string; sender: string } {
  const normalized = text.replace(/\r\n?/g, "\n");
  const start = Math.min(
    normalized.length,
    ...QUOTE_STARTS.map((pattern) => normalized.search(pattern)).filter(
      (index) => index >= 0,
    ),
  );
  return {
    quoted: normalized.slice(start).trim().slice(0, MAX_QUOTED_TEXT),
    sender: normalized.slice(0, start).trim().slice(0, MAX_SENDER_TEXT),
  };
}

/**
 * Read one inbox message as an email request from a verified sender at an
 * allowed domain, or return why Junior drops it.
 */
export function readEmailRequest(
  message: GmailMessage,
  options: { accountEmail: string; allowedDomains: string[] },
): { request: EmailRequest } | { dropped: EmailDropReason } {
  const payload = message.payload;
  const sender = parseSender(headerValues(payload, "From").join(", "));
  if (!sender) return { dropped: "invalid_sender" };
  if (sender.email === options.accountEmail) return { dropped: "from_junior" };
  const domain = emailDomain(sender.email);
  if (!domain || !options.allowedDomains.includes(domain)) {
    return { dropped: "outside_domain" };
  }
  if (!dmarcPassed(payload, domain)) return { dropped: "unauthenticated" };
  if (isAutomated(payload)) return { dropped: "automated" };
  // Calendar replies and updates come from people, but they are not requests.
  if (
    allParts(payload).some(
      (part) => part.mimeType?.toLowerCase() === "text/calendar",
    )
  ) {
    return { dropped: "calendar_reply" };
  }
  const text = plainText(payload);
  const split = text ? splitQuoted(text) : undefined;
  if (!split || (!split.sender && !split.quoted)) return { dropped: "no_text" };

  const sentAtMs = Number(message.internalDate);
  return {
    request: {
      cc: addresses(header(payload, "Cc")),
      messageId: message.id,
      quotedText: split.quoted,
      sender,
      senderText: split.sender,
      ...(Number.isFinite(sentAtMs) && sentAtMs > 0
        ? { sentAt: new Date(sentAtMs).toISOString().replace(/\.\d{3}Z$/, "Z") }
        : undefined),
      subject: header(payload, "Subject") ?? "",
      threadId: message.threadId,
      to: addresses(header(payload, "To")),
    },
  };
}
