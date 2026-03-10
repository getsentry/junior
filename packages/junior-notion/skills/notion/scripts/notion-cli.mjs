#!/usr/bin/env node

/**
 * Unified Notion helper for LLM-facing search and fetch operations.
 *
 * `search` preserves the public v1 Search API's native ordering as closely as possible and
 * returns broad candidate results for the raw query without forcing a winner.
 *
 * `fetch` loads normalized content for a specific page or data source chosen from search
 * results so the model can summarize a stable payload.
 */

const DEFAULT_API_BASE_URL = "https://api.notion.com/v1";
// Keep this pinned in sync with packages/junior-notion/plugin.yaml.
const DEFAULT_NOTION_VERSION = "2025-09-03";
const DEFAULT_PAGE_SIZE = 100;
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

  return {
    ok: true,
    query_variants: searchQueries,
    attempts,
    result_count: candidateMap.size,
    results: [...candidateMap.values()].map((candidate) => ({
      id: candidate.id,
      object: candidate.object,
      title: candidate.title,
      url: candidate.url,
      last_edited_time: candidate.last_edited_time,
      query: candidate.query,
    })),
  };
}

function simplifyFormulaValue(formula) {
  if (!formula || typeof formula !== "object") {
    return null;
  }

  switch (formula.type) {
    case "string":
      return formula.string ?? null;
    case "number":
      return formula.number ?? null;
    case "boolean":
      return formula.boolean ?? null;
    case "date":
      return formula.date
        ? {
            start: formula.date.start ?? null,
            end: formula.date.end ?? null,
          }
        : null;
    case "page":
      return formula.page?.id ?? null;
    case "person":
      return formula.person?.name || formula.person?.id || null;
    case "list":
      return Array.isArray(formula.list)
        ? formula.list.map((item) => simplifyFormulaValue(item)).filter((item) => item !== null)
        : [];
    default:
      return null;
  }
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
      return simplifyFormulaValue(property.formula);
    case "created_time":
      return property.created_time ?? null;
    case "last_edited_time":
      return property.last_edited_time ?? null;
    case "unique_id":
      if (!property.unique_id) {
        return null;
      }
      if (property.unique_id.prefix) {
        return `${property.unique_id.prefix}-${property.unique_id.number ?? ""}`;
      }
      return property.unique_id.number ?? null;
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

async function fetchPageMetadata(pageId) {
  const page = await notionRequest(`/pages/${pageId}`);
  return simplifyPageRecord(page);
}

async function fetchPageMarkdown(pageId) {
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
    target: {
      id: String(dataSource?.id ?? dataSourceId),
      object: "data_source",
      title: extractResultTitle(dataSource),
      url: String(dataSource?.url ?? ""),
      last_edited_time: dataSource?.last_edited_time ?? null,
    },
    content: {
      type: "data_source",
      schema: simplifyDataSourceSchema(dataSource),
      rows: Array.isArray(rowsResponse?.results)
        ? rowsResponse.results.map((row) => simplifyPageRecord(row))
        : [],
    },
  };
}

async function fetchContent({ id, object, rowLimit = DEFAULT_ROW_LIMIT } = {}) {
  if (!id) {
    throw new Error("notion fetch requires --id");
  }
  if (object !== "page" && object !== "data_source") {
    throw new Error("notion fetch requires --object page|data_source");
  }

  if (object === "page") {
    const [target, markdown] = await Promise.all([fetchPageMetadata(id), fetchPageMarkdown(id)]);
    return {
      ok: true,
      target,
      content: {
        type: "page",
        markdown,
      },
    };
  }

  return {
    ok: true,
    ...(await fetchDataSourceContent(id, rowLimit)),
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "search" && command !== "fetch") {
    throw new Error("notion-cli requires a subcommand: search | fetch");
  }

  const args = parseArgs(rest[0] === "--" ? rest.slice(1) : rest);
  const result =
    command === "search"
      ? await (() => {
          const queries = toStringArray(args.query);
          if (queries.length === 0) {
            throw new Error("notion search requires at least one --query");
          }
          return searchNotion({
            queries,
            pageSize: args["page-size"] ? Number.parseInt(args["page-size"], 10) : DEFAULT_PAGE_SIZE,
            object: normalizeWhitespace(args.object),
          });
        })()
      : await fetchContent({
          id: normalizeWhitespace(args.id),
          object: normalizeWhitespace(args.object),
          rowLimit: args["row-limit"] ? Number.parseInt(args["row-limit"], 10) : DEFAULT_ROW_LIMIT,
        });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
