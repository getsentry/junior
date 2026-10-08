/**
 * Credentials that the proxy must never write to disk.
 *
 * The proxy learns the values of credential headers from each request that
 * it sees, and the config can add more values. It replaces each known value
 * with `<<redacted>>` before it writes a recording or a miss file.
 */
import type { IncomingHttpHeaders } from "node:http";

/**
 * Request headers that can carry credentials. The match is broad on
 * purpose: redacting a value that is not a credential costs little.
 */
const CREDENTIAL_HEADER =
  /auth|token|secret|key|cookie|session|password|credential|signature/i;
/** Shorter parts, such as `Bearer`, are not credentials. */
const MIN_LENGTH = 12;
const REDACTED = "<<redacted>>";

/** Create the secret list of one proxy run, with the values of `initial`. */
export function createSecrets(initial: string[] = []) {
  const values = new Set<string>();
  // Keep the whole value and its parts, such as the token of
  // `Bearer <token>` or each value of a cookie header.
  const add = (value: string) => {
    for (const part of [value, ...value.split(/[\s;,=]+/)]) {
      if (part.length >= MIN_LENGTH) values.add(part);
    }
  };
  initial.forEach(add);
  // Redact longer values first, so no part of one stays visible.
  const longestFirst = () => [...values].sort((a, b) => b.length - a.length);

  return {
    /** Learn the credentials in the headers of a request. */
    learn(headers: IncomingHttpHeaders): void {
      for (const [name, value] of Object.entries(headers)) {
        if (!CREDENTIAL_HEADER.test(name) || value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) add(item);
      }
    },

    /** `text` with each known credential replaced. */
    redact(text: string): string {
      let result = text;
      for (const value of longestFirst()) {
        result = result.replaceAll(value, REDACTED);
      }
      return result;
    },
  };
}

/** The secret list of one proxy run. */
export type Secrets = ReturnType<typeof createSecrets>;
