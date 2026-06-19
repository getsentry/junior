import type { MemoryScope, MemorySensitivity } from "./types";

const SECRET_PATTERNS = [
  /\b(?:api[_-]?key|secret|token|password|passwd|private[_-]?key)\b/i,
  /\b(?:xox[baprs]-|gh[pousr]_|sk-[A-Za-z0-9_-]{12,})/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Return whether content matches the plugin's deterministic secret rejection. */
export function containsMemorySecret(content: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(content));
}

/** Validate deterministic write policy before memory content reaches storage. */
export function validateMemoryWritePolicy(args: {
  content: string;
  scope: MemoryScope;
  sensitivity: MemorySensitivity;
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
  if (args.scope === "conversation" && args.sensitivity === "sensitive") {
    return {
      ok: false,
      reason: "Sensitive memories can only be stored personally.",
    };
  }
  return { ok: true };
}
