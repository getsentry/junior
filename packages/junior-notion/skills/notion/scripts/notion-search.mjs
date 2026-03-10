#!/usr/bin/env node

/**
 * Search Notion for candidate pages and data sources that an LLM can choose from.
 *
 * This script is intentionally retrieval-only. It should preserve the public Search API's
 * native ordering as closely as possible and return a broad candidate list for the raw query
 * without forcing a single winner or fetching page/database content. The LLM can then choose
 * which item to inspect next via the separate fetch script.
 */

const DEFAULT_API_BASE_URL = "https://api.notion.com/v1";
const DEFAULT_NOTION_VERSION = "2025-09-03";
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_LIMIT = 2;
function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      if (parsed[rawKey] === undefined) {
        parsed[rawKey] = inlineValue;
      } else if (Array.isArray(parsed[rawKey])) {
        parsed[rawKey].push(inlineValue);
      } else {
        parsed[rawKey] = [parsed[rawKey], inlineValue];
      }
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[rawKey] = "true";
      continue;
    }
    if (parsed[rawKey] === undefined) {
      parsed[rawKey] = next;
    } else if (Array.isArray(parsed[rawKey])) {
      parsed[rawKey].push(next);
    } else {
      parsed[rawKey] = [parsed[rawKey], next];
    }
    index += 1;
  }
  return parsed;
}

function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function toStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeWhitespace(item)).filter(Boolean);
  }
  const normalized = normalizeWhitespace(value);
  return normalized ? [normalized] : [];
}

function buildSearchQueries(queries) {
  const normalizedQueries = [];
  const seenQueries = new Set();
  for (const value of toStringArray(queries)) {
    if (seenQueries.has(value)) {
      continue;
    }
    seenQueries.add(value);
    normalizedQueries.push(value);
  }
  return normalizedQueries;
}

function extractPlainText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) => {
      if (typeof item?.plain_text === "string") {
        return item.plain_text;
      }
      if (typeof item?.text?.content === "string") {
        return item.text.content;
      }
      return "";
    })
    .join("")
    .trim();
}

function extractTitleFromProperties(properties) {
  if (!properties || typeof properties !== "object") {
    return "";
  }
  for (const property of Object.values(properties)) {
    if (property?.type === "title") {
      return extractPlainText(property.title);
    }
  }
  return "";
}

function extractResultTitle(result) {
  if (!result || typeof result !== "object") {
    return "";
  }
  if (Array.isArray(result.title)) {
    return extractPlainText(result.title);
  }
  if (typeof result.title === "string") {
    return result.title.trim();
  }
  if (result.properties) {
    return extractTitleFromProperties(result.properties);
  }
  return "";
}

function simplifySearchResult(result) {
  return {
    id: String(result?.id ?? ""),
    object: String(result?.object ?? ""),
    title: extractResultTitle(result),
    url: String(result?.url ?? ""),
    last_edited_time: result?.last_edited_time ?? null,
  };
}

function buildHeaders(extraHeaders) {
  const headers = {
    Accept: "application/json",
    "Notion-Version": process.env.NOTION_VERSION || DEFAULT_NOTION_VERSION,
    ...extraHeaders,
  };
  const token = normalizeWhitespace(process.env.NOTION_TOKEN);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function getApiBaseUrl() {
  return normalizeWhitespace(process.env.NOTION_API_BASE_URL) || DEFAULT_API_BASE_URL;
}

function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function parseRetryAfterMs(value) {
  const seconds = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(seconds) || seconds < 0) {
    return 0;
  }
  return Math.ceil(seconds * 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notionRequest(pathname, init = {}, options = {}) {
  const retryLimit = options.retryLimit ?? DEFAULT_RETRY_LIMIT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const method = init.method ?? "GET";
  const headers = buildHeaders(init.headers ?? {});
  const url = `${getApiBaseUrl()}${pathname}`;

  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        method,
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        const bodyText = await response.text();
        if (attempt < retryLimit && isRetryableStatus(response.status)) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          await sleep(retryAfterMs || 250 * (attempt + 1));
          continue;
        }
        throw new Error(
          `Notion API ${method} ${pathname} failed with ${response.status}: ${bodyText || response.statusText}`,
        );
      }
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        return await response.json();
      }
      return await response.text();
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`Notion API ${method} ${pathname} failed after retries`);
}

async function searchOnce(query, pageSize, object) {
  const body = {
    query,
    page_size: pageSize,
  };
  if (object) {
    body.filter = {
      property: "object",
      value: object,
    };
  }
  return await notionRequest("/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function searchNotion({ queries = [], pageSize = DEFAULT_PAGE_SIZE, object = "" } = {}) {
  const searchQueries = buildSearchQueries(queries);
  const attempts = [];
  const candidateMap = new Map();

  for (const variant of searchQueries) {
    const response = await searchOnce(variant, pageSize, object || undefined);
    const results = Array.isArray(response?.results) ? response.results : [];
    attempts.push({
      query: variant,
      object: object || "page_or_data_source",
      result_count: results.length,
      has_more: Boolean(response?.has_more),
      next_cursor: response?.next_cursor ?? null,
    });

    for (const result of results) {
      if (!result?.id || candidateMap.has(result.id)) {
        continue;
      }
      candidateMap.set(result.id, {
        ...simplifySearchResult(result),
        query: variant,
      });
    }
  }

  const candidates = [...candidateMap.values()];

  return {
    ok: true,
    query_variants: searchQueries,
    attempts,
    result_count: candidates.length,
    results: candidates.map((candidate) => ({
      id: candidate.id,
      object: candidate.object,
      title: candidate.title,
      url: candidate.url,
      last_edited_time: candidate.last_edited_time,
      query: candidate.query,
    })),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const queries = toStringArray(args.query);
  if (queries.length === 0) {
    throw new Error("notion-search requires at least one --query");
  }
  const result = await searchNotion({
    queries,
    pageSize: args["page-size"] ? Number.parseInt(args["page-size"], 10) : DEFAULT_PAGE_SIZE,
    object: normalizeWhitespace(args.object),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
