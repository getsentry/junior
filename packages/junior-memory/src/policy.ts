import type { MemorySubjectType } from "./types";

const SECRET_PATTERNS = [
  /\b(?:api[_-]?key|secret|token|password|passwd|private[_-]?key)\b/i,
  /\b(?:xox[baprs]-|gh[pousr]_|sk-[A-Za-z0-9_-]{12,})/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

// Conservative guard for obvious third-party profile facts in user memories.
const THIRD_PARTY_USER_SUBJECT_PATTERNS = [
  /^\s*(?!(?:User|Requester)\b)(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?|@[A-Za-z0-9._-]+)\s+(?:is|prefers|likes|owns|uses|works|has|wants|needs|leads|manages|reports)\b/,
];

// Deterministic V1 public-only rejection for obvious non-public categories.
const NON_PUBLIC_MEMORY_PATTERNS = [
  /\b(?:health|medical|medication|diagnos(?:is|ed)|disability|therapy|hospital|surgery|cancer|pregnan(?:t|cy)|family[-\s]?care)\b/i,
  /\b(?:legal|lawsuit|attorney|immigration|visa|passport|ssn|social security|government id|driver'?s license)\b/i,
  /\b(?:salary|compensation|bonus|equity grant|performance review|promotion|discipline|termination|fired|laid off|pip)\b/i,
  /\b(?:religion|religious|politics|political|union activity|protected class|sexual orientation)\b/i,
  /\b(?:debt|bankruptcy|financial hardship|divorce|dating|private life|interviewing elsewhere)\b/i,
  /\b(?:unreliable|lazy|incompetent|angry|unstable|bad teammate|dislikes working with)\b/i,
  /\b(?:gossip|venting|personal conflict|raw conversation summary)\b/i,
];

/** Return whether content matches the plugin's deterministic secret rejection. */
export function containsMemorySecret(content: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(content));
}

/** Validate deterministic write policy before memory content reaches storage. */
export function validateMemoryWritePolicy(args: {
  content: string;
  subjectType: MemorySubjectType;
}): { ok: true } | { ok: false; reason: string } {
  if (!args.content.trim()) {
    return { ok: false, reason: "Memory content is required." };
  }
  if (containsMemorySecret(args.content)) {
    return {
      ok: false,
      reason: "Memory content appears to contain a secret.",
    };
  }
  if (
    NON_PUBLIC_MEMORY_PATTERNS.some((pattern) => pattern.test(args.content))
  ) {
    return {
      ok: false,
      reason:
        "Memory content appears to contain non-public or sensitive information.",
    };
  }
  if (
    args.subjectType === "user" &&
    THIRD_PARTY_USER_SUBJECT_PATTERNS.some((pattern) =>
      pattern.test(args.content),
    )
  ) {
    return {
      ok: false,
      reason:
        "User-subject memories can only store first-person facts about the current requester.",
    };
  }
  return { ok: true };
}
