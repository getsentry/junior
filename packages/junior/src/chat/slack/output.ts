import type { FileUpload, PostableMessage } from "chat";
import { logWarn } from "@/chat/logging";
import { lookupSlackUserIdByName } from "@/chat/slack/user";

const MAX_INLINE_CHARS = 2200;
const MAX_INLINE_LINES = 45;

/** Insert blank lines between content blocks so Slack renders them with visual separation. */
export function ensureBlockSpacing(text: string): string {
  const codeBlockPattern = /^```/;
  const listItemPattern = /^[-*•]\s|^\d+\.\s/;
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isCodeFence = codeBlockPattern.test(line.trimStart());

    if (isCodeFence) {
      // Insert blank line before code fence if needed (only outside code blocks)
      if (!inCodeBlock) {
        const prev = result.length > 0 ? result[result.length - 1] : undefined;
        if (prev !== undefined && prev.trim() !== "") {
          result.push("");
        }
      }
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    const prev = result.length > 0 ? result[result.length - 1] : undefined;

    // Insert blank line if: prev is non-empty, current is non-empty,
    // prev is not already a blank line, and they're not both list items
    if (
      prev !== undefined &&
      prev.trim() !== "" &&
      line.trim() !== "" &&
      !(
        listItemPattern.test(prev.trimStart()) &&
        listItemPattern.test(line.trimStart())
      )
    ) {
      result.push("");
    }

    result.push(line);
  }

  return result.join("\n");
}

/**
 * Resolve `@name` patterns in text to Slack `<@USERID>` entities.
 *
 * The postprocessor:
 * 1. Skips patterns that look like email addresses (already have `@host` context)
 * 2. Skips patterns that are already proper Slack mention entities
 * 3. For each remaining `@name` candidate, attempts a name→ID lookup via the
 *    Slack `users.list` API (cached). Unresolvable names are left as-is.
 *
 * The known-participant map is consulted first (zero API cost) before falling
 * back to the full workspace lookup.
 */
export async function resolveMentions(
  text: string,
  knownParticipants?: Map<string, string>,
): Promise<string> {
  // Pattern: @word or @first.last, not preceded by a word char (avoids emails)
  // and not already inside a Slack entity like <@U...>
  const mentionPattern = /(?<![<\w])@([\w][\w.-]*[\w]|[\w])/g;

  const matches = [...text.matchAll(mentionPattern)];
  if (matches.length === 0) {
    return text;
  }

  // Collect unique names to resolve in parallel
  const uniqueNames = [...new Set(matches.map((m) => m[1]))];
  const resolvedIds = new Map<string, string>();

  await Promise.all(
    uniqueNames.map(async (name) => {
      // Check known participants first (free) — exact match only to avoid
      // resolving @al to "alex" or similar prefix collisions.
      const normalizedName = name.toLowerCase().replace(/[\s.]/g, "");
      for (const [participantName, userId] of knownParticipants ?? []) {
        const normalizedParticipant = participantName
          .toLowerCase()
          .replace(/[\s.]/g, "");
        if (normalizedParticipant === normalizedName) {
          resolvedIds.set(name, userId);
          return;
        }
      }

      // Fall back to workspace lookup
      const userId = await lookupSlackUserIdByName(name);
      if (userId) {
        resolvedIds.set(name, userId);
      }
    }),
  );

  if (resolvedIds.size === 0) {
    return text;
  }

  return text.replace(mentionPattern, (match, name: string) => {
    const userId = resolvedIds.get(name);
    return userId ? `<@${userId}>` : match;
  });
}

function normalizeForSlack(text: string): string {
  let normalized = text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
  normalized = ensureBlockSpacing(normalized);
  return normalized.replace(/\n{3,}/g, "\n\n").trim();
}

/** Normalize text for Slack and wrap it as a PostableMessage with optional file attachments. */
export async function buildSlackOutputMessage(
  text: string,
  files?: FileUpload[],
  knownParticipants?: Map<string, string>,
): Promise<PostableMessage> {
  const normalized = normalizeForSlack(text);
  const fileCount = files?.length ?? 0;

  if (!normalized) {
    if (fileCount > 0) {
      return {
        raw: "",
        files,
      };
    }

    logWarn(
      "slack_output_normalized_empty",
      {},
      {
        "app.output.original_length": text.length,
        "app.output.parsed_length": normalized.length,
        "app.output.file_count": fileCount,
      },
      "Slack output normalized to empty content",
    );
    return {
      markdown: "I couldn't produce a response.",
      files,
    };
  }

  const resolved = await resolveMentions(normalized, knownParticipants);

  return {
    markdown: resolved,
    files,
  };
}

export const slackOutputPolicy = {
  maxInlineChars: MAX_INLINE_CHARS,
  maxInlineLines: MAX_INLINE_LINES,
};
