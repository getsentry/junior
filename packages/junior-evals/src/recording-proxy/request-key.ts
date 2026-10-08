/**
 * The key of a recorded request, and the parts that miss diagnosis
 * compares.
 *
 * The key is the hash of the rule, the method, the URL, the key headers,
 * and the body. A JSON body has sorted object keys, so key order does not
 * matter. Each changing value of the rule is `<<name>>` in the key
 * (`values.ts`).
 *
 * A recording also keeps a short hash of each part of its request: the
 * method, the URL, each key header, each top-level field of a JSON body,
 * and each item of a top-level array, such as `messages[3]`. When a request
 * has no recording, the proxy finds the recording with the most equal parts
 * and reports the parts that differ.
 */
import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { RecordingRule } from "./types.ts";
import {
  extractValues,
  type RequestValues,
  type ValuePatterns,
} from "./values.ts";

/** Change this to make every recording a miss. */
const KEY_VERSION = "http-v1";

/** A short hash of each part of a request, by part name. */
export type RequestParts = Record<string, string>;

/** A request as the key sees it. */
export interface KeyedRequest {
  /** The name of the recording file, without `.json`. */
  key: string;
  parts: RequestParts;
  /** The changing values of the request, in their order. */
  values: RequestValues;
  /** The request that the key hashes. Miss files show it. */
  normalized: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };
}

/** JSON with sorted object keys, so equal bodies give equal keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function parseJson(body: string): unknown {
  try {
    return body ? JSON.parse(body) : undefined;
  } catch {
    return undefined;
  }
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const shortHash = (text: string) => sha256(text).slice(0, 12);

function bodyParts(
  json: unknown,
  normalizedBody: string,
  patterns: ValuePatterns | undefined,
): RequestParts {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return normalizedBody ? { body: shortHash(normalizedBody) } : {};
  }
  const part = (value: unknown) =>
    shortHash(extractValues(stableStringify(value), patterns).text);
  const parts: RequestParts = {};
  for (const [field, value] of Object.entries(json)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      parts[`${field}.length`] = shortHash(String(value.length));
      value.forEach((item, index) => {
        parts[`${field}[${index}]`] = part(item);
      });
    } else {
      parts[field] = part(value);
    }
  }
  return parts;
}

/** The key, the parts, and the changing values of a request. */
export function keyRequest(
  rule: RecordingRule,
  request: {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body: string;
  },
): KeyedRequest {
  const headers = Object.fromEntries(
    (rule.keyHeaders ?? []).map((name) => [
      name,
      String(request.headers[name] ?? ""),
    ]),
  );
  const json = parseJson(request.body);
  const { text, values } = extractValues(
    json === undefined ? request.body : stableStringify(json),
    rule.values,
  );
  const key = sha256(
    [
      KEY_VERSION,
      rule.name,
      request.method,
      request.url,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      text,
    ].join("\n"),
  );
  const parts: RequestParts = {
    method: shortHash(request.method),
    url: shortHash(request.url),
  };
  for (const [name, value] of Object.entries(headers)) {
    parts[`header ${name}`] = shortHash(value);
  }
  Object.assign(parts, bodyParts(json, text, rule.values));
  return {
    key,
    parts,
    values,
    normalized: {
      method: request.method,
      url: request.url,
      headers,
      // A placeholder for a number makes the JSON invalid. Keep its text.
      body: parseJson(text) ?? text,
    },
  };
}

const partOrder = new Intl.Collator("en", { numeric: true }).compare;

/**
 * The candidate with the most equal parts, and the parts that differ from
 * it, in a readable order. Returns `undefined` when there is no candidate.
 */
export function closestRequest<T extends { parts: RequestParts }>(
  parts: RequestParts,
  candidates: Iterable<T>,
): { candidate: T; differs: string[] } | undefined {
  let best: T | undefined;
  let bestEqual = -1;
  for (const candidate of candidates) {
    const equal = Object.keys(parts).filter(
      (name) => candidate.parts[name] === parts[name],
    ).length;
    if (equal > bestEqual) {
      bestEqual = equal;
      best = candidate;
    }
  }
  if (!best) return undefined;
  const names = new Set([...Object.keys(parts), ...Object.keys(best.parts)]);
  const differs = [...names]
    .filter((name) => parts[name] !== best.parts[name])
    .sort(partOrder);
  return { candidate: best, differs };
}

/** Name some parts, such as `messages[3], tools`. */
export function describeParts(parts: string[]): string {
  if (parts.length === 0) return "no part";
  const shown = parts.slice(0, 6).join(", ");
  return parts.length > 6 ? `${shown} and ${parts.length - 6} more` : shown;
}
