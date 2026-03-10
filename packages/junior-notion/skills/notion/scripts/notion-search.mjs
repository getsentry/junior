#!/usr/bin/env node

const DEFAULT_API_BASE_URL = "https://api.notion.com/v1";
const DEFAULT_NOTION_VERSION = "2025-09-03";
const DEFAULT_PAGE_SIZE = 10;
const DEFAULT_ROW_LIMIT = 10;
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

function tokenize(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]+/g, " ")
    .split(/[\s/]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function toStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeWhitespace(item)).filter(Boolean);
  }
  const normalized = normalizeWhitespace(value);
  return normalized ? [normalized] : [];
}

function buildSearchQueries({ query = "", queries = [] }) {
  const variants = [];
  const seenVariants = new Set();
  const pushVariant = (value) => {
    const normalized = normalizeWhitespace(value);
    if (seenVariants.has(normalized)) {
      return;
    }
    seenVariants.add(normalized);
    variants.push(normalized);
  };

  for (const value of [...toStringArray(query), ...toStringArray(queries)]) {
    pushVariant(value);
  }
  pushVariant("");

  return variants;
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

function scoreTitleMatch(title, tokens, queries) {
  const normalizedTitle = title.toLowerCase();
  let score = 0;
  for (const query of queries) {
    if (!query) {
      continue;
    }
    const normalizedQuery = query.toLowerCase();
    if (normalizedTitle === normalizedQuery) {
      score += 120;
    } else if (normalizedTitle.includes(normalizedQuery)) {
      score += 60;
    }
  }
  for (const token of tokens) {
    if (normalizedTitle.includes(token)) {
      score += 15;
    }
  }
  return score;
}

function rankResult(result, context) {
  const title = extractResultTitle(result);
  const object = String(result?.object ?? "");
  const score =
    scoreTitleMatch(title, context.tokens, context.queries) +
    (object === "page" ? 5 : 0) +
    (title ? 10 : 0);

  return {
    id: String(result?.id ?? ""),
    object,
    title,
    url: String(result?.url ?? ""),
    score,
  };
}

function buildHeaders(extraHeaders) {
  const headers = {
    Accept: "application/json",
    "Notion-Version": process.env.NOTION_VERSION || DEFAULT_NOTION_VERSION,
    ...extraHeaders,
  };
  const token = normalizeWhitespace(process.env.NOTION_TOKEN);
  if (token && token !== "host_managed_credential") {
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

async function searchOnce(query, pageSize) {
  return await notionRequest("/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      page_size: pageSize,
    }),
  });
}

function simplifyPropertyValue(property) {
  if (!property || typeof property !== "object") {
    return null;
  }
  switch (property.type) {
    case "title":
      return extractPlainText(property.title);
    case "rich_text":
      return extractPlainText(property.rich_text);
    case "status":
      return property.status?.name ?? null;
    case "select":
      return property.select?.name ?? null;
    case "multi_select":
      return Array.isArray(property.multi_select)
        ? property.multi_select.map((item) => item?.name).filter(Boolean)
        : [];
    case "number":
      return property.number ?? null;
    case "checkbox":
      return property.checkbox ?? null;
    case "url":
      return property.url ?? null;
    case "email":
      return property.email ?? null;
    case "phone_number":
      return property.phone_number ?? null;
    case "date":
      return property.date
        ? {
            start: property.date.start ?? null,
            end: property.date.end ?? null,
          }
        : null;
    case "people":
      return Array.isArray(property.people)
        ? property.people.map((item) => item?.name || item?.id).filter(Boolean)
        : [];
    case "relation":
      return Array.isArray(property.relation)
        ? property.relation.map((item) => item?.id).filter(Boolean)
        : [];
    case "formula":
      return simplifyPropertyValue(property.formula);
    case "created_time":
      return property.created_time ?? null;
    case "last_edited_time":
      return property.last_edited_time ?? null;
    case "unique_id":
      return property.unique_id
        ? `${property.unique_id.prefix ?? ""}${property.unique_id.number ?? ""}`
        : null;
    default:
      return null;
  }
}

function simplifyPageRecord(page) {
  const properties = {};
  if (page?.properties && typeof page.properties === "object") {
    for (const [key, value] of Object.entries(page.properties)) {
      properties[key] = simplifyPropertyValue(value);
    }
  }

  return {
    id: String(page?.id ?? ""),
    object: String(page?.object ?? "page"),
    title: extractResultTitle(page),
    url: String(page?.url ?? ""),
    last_edited_time: page?.last_edited_time ?? null,
    properties,
  };
}

function simplifyDataSourceSchema(dataSource) {
  const properties = dataSource?.properties;
  if (!properties || typeof properties !== "object") {
    return [];
  }
  return Object.entries(properties).map(([name, value]) => ({
    name,
    type: String(value?.type ?? "unknown"),
  }));
}

async function fetchPageContent(pageId) {
  const response = await notionRequest(`/pages/${pageId}/markdown`);
  if (typeof response === "string") {
    return response;
  }
  if (typeof response?.markdown === "string") {
    return response.markdown;
  }
  if (Array.isArray(response?.results)) {
    return response.results
      .map((item) => (typeof item === "string" ? item : item?.markdown ?? ""))
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(response, null, 2);
}

async function fetchDataSourceContent(dataSourceId, rowLimit) {
  const [dataSource, rowsResponse] = await Promise.all([
    notionRequest(`/data_sources/${dataSourceId}`),
    notionRequest(`/data_sources/${dataSourceId}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: rowLimit }),
    }),
  ]);

  return {
    schema: simplifyDataSourceSchema(dataSource),
    rows: Array.isArray(rowsResponse?.results)
      ? rowsResponse.results.map((row) => simplifyPageRecord(row))
      : [],
  };
}

async function searchNotion({
  query = "",
  queries = [],
  pageSize = DEFAULT_PAGE_SIZE,
  rowLimit = DEFAULT_ROW_LIMIT,
} = {}) {
  const searchQueries = buildSearchQueries({ query, queries });
  const tokens = [...new Set(tokenize(searchQueries.join(" ")))];
  const attempts = [];
  const candidateMap = new Map();

  for (const variant of searchQueries) {
    const response = await searchOnce(variant, pageSize);
    const results = Array.isArray(response?.results) ? response.results : [];
    attempts.push({
      query: variant,
      result_count: results.length,
    });

    for (const result of results) {
      if (!result?.id) {
        continue;
      }
      const ranked = rankResult(result, { tokens, queries: searchQueries });
      const existing = candidateMap.get(ranked.id);
      if (!existing || ranked.score > existing.score) {
        candidateMap.set(ranked.id, ranked);
      }
    }

    if (results.length > 0 && variant) {
      break;
    }
  }

  const candidates = [...candidateMap.values()].sort((left, right) => right.score - left.score);
  const selected = candidates[0] ?? null;
  if (!selected) {
    return {
      ok: true,
      query_variants: searchQueries,
      attempts,
      result_count: 0,
      results: [],
      selected: null,
      content: null,
    };
  }

  let content = null;
  let contentError = null;
  try {
    if (selected.object === "page") {
      content = {
        type: "page",
        markdown: await fetchPageContent(selected.id),
      };
    } else if (selected.object === "data_source") {
      content = {
        type: "data_source",
        ...(await fetchDataSourceContent(selected.id, rowLimit)),
      };
    }
  } catch (error) {
    contentError = error instanceof Error ? error.message : String(error);
  }

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
      score: candidate.score,
    })),
    selected: {
      id: selected.id,
      object: selected.object,
      title: selected.title,
      url: selected.url,
      score: selected.score,
    },
    content,
    ...(contentError ? { content_error: contentError } : {}),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const queries = toStringArray(args.query);
  const query = queries[0] ?? "";
  const remainingQueries = queries.slice(1);
  if (!normalizeWhitespace(query) && remainingQueries.length === 0) {
    throw new Error("notion-search requires at least one --query");
  }
  const result = await searchNotion({
    query,
    queries: remainingQueries,
    pageSize: args["page-size"] ? Number.parseInt(args["page-size"], 10) : DEFAULT_PAGE_SIZE,
    rowLimit: args["row-limit"] ? Number.parseInt(args["row-limit"], 10) : DEFAULT_ROW_LIMIT,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
