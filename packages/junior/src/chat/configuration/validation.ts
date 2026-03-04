const CONFIG_KEY_RE = /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/;
const SECRET_KEY_RE =
  /(?:^|[_.-])(token|secret|password|passphrase|api[-_]?key|private[-_]?key|credential|auth)(?:$|[_.-])/i;
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:ghp|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z\-_]{30,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/
];

export function validateConfigKey(key: string): string | undefined {
  const trimmed = key.trim();
  if (!trimmed) {
    return "Configuration key must not be empty";
  }
  if (!CONFIG_KEY_RE.test(trimmed)) {
    return `Invalid configuration key "${key}"; expected dotted lowercase namespace (for example "github.repo")`;
  }
  if (SECRET_KEY_RE.test(trimmed)) {
    return `Configuration key "${key}" appears to be secret-related and is not allowed`;
  }
  return undefined;
}

function collectStringValues(value: unknown, output: string[], depth = 0): void {
  if (depth > 5) {
    return;
  }
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringValues(item, output, depth + 1);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output.push(key);
      collectStringValues(nested, output, depth + 1);
    }
  }
}

export function validateConfigValue(value: unknown): string | undefined {
  const stringValues: string[] = [];
  collectStringValues(value, stringValues);
  for (const text of stringValues) {
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(text)) {
        return "Configuration value appears to contain secret material and is not allowed";
      }
    }
  }
  return undefined;
}
