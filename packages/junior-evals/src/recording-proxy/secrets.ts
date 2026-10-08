/**
 * Credentials that the proxy must never write to disk.
 *
 * The proxy learns the values of credential headers from each request that
 * it sees, and the config can add more values. The check is an exact
 * match, so random text in a response never matches by accident.
 */
import type { IncomingHttpHeaders } from "node:http";

/** Request headers that carry credentials. Names are lowercase. */
const CREDENTIAL_HEADER =
  /^(authorization|proxy-authorization|cookie|x-api-key)$|(token|secret|api-key)$/;
/** Shorter parts, such as `Bearer`, are not credentials. */
const MIN_LENGTH = 12;
const REDACTED = "<<redacted>>";

/** Create the secret list of one proxy run, with the values of `initial`. */
export function createSecrets(initial: string[] = []) {
  const values = new Set<string>();
  const add = (value: string) => {
    for (const part of value.split(/[\s;,=]+/)) {
      if (part.length >= MIN_LENGTH) values.add(part);
    }
  };
  initial.forEach(add);

  return {
    /** Learn the credentials in the headers of a request. */
    learn(headers: IncomingHttpHeaders): void {
      for (const [name, value] of Object.entries(headers)) {
        if (!CREDENTIAL_HEADER.test(name) || value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) add(item);
      }
    },

    /** Whether `text` contains a known credential. */
    has(text: string): boolean {
      for (const value of values) if (text.includes(value)) return true;
      return false;
    },

    /** `text` with each known credential replaced. */
    redact(text: string): string {
      let result = text;
      for (const value of values) result = result.replaceAll(value, REDACTED);
      return result;
    },
  };
}

/** The secret list of one proxy run. */
export type Secrets = ReturnType<typeof createSecrets>;
