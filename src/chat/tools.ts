import dns from "node:dns/promises";
import net from "node:net";
import { tool } from "ai";
import { z } from "zod";
import { findSkillByName, loadSkillsByName, type SkillMetadata } from "@/chat/skills";

const USER_AGENT = "shim-bot/0.1";
const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const DEFAULT_MAX_CHARS = 6000;
const MAX_FETCH_CHARS = 12000;
const MAX_FETCH_BYTES = 256_000;

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((chunk) => Number.parseInt(chunk, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }

  if (parts[0] === 10 || parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 0) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

async function assertPublicUrl(rawUrl: string): Promise<URL> {
  const parsed = new URL(rawUrl);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Local/private hostnames are blocked");
  }

  const hostIpType = net.isIP(hostname);
  if (hostIpType === 4 && isPrivateIpv4(hostname)) {
    throw new Error("Private IPv4 addresses are blocked");
  }
  if (hostIpType === 6 && isPrivateIpv6(hostname)) {
    throw new Error("Private IPv6 addresses are blocked");
  }

  if (hostIpType === 0) {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) {
      throw new Error("Could not resolve hostname");
    }

    for (const record of records) {
      if (record.family === 4 && isPrivateIpv4(record.address)) {
        throw new Error("Resolved to a private IPv4 address");
      }
      if (record.family === 6 && isPrivateIpv6(record.address)) {
        throw new Error("Resolved to a private IPv6 address");
      }
    }
  }

  return parsed;
}

function stripHtml(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });

  try {
    return await Promise.race([task, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchTextWithRedirects(url: URL, redirectsLeft: number): Promise<Response> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: abortController.signal,
    headers: {
      "user-agent": USER_AGENT
    }
  }).finally(() => clearTimeout(timer));

  const isRedirect = response.status >= 300 && response.status < 400;
  if (!isRedirect) {
    return response;
  }

  if (redirectsLeft <= 0) {
    throw new Error("Too many redirects");
  }

  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Redirect missing location");
  }

  const nextUrl = new URL(location, url);
  const safeUrl = await assertPublicUrl(nextUrl.toString());
  return fetchTextWithRedirects(safeUrl, redirectsLeft - 1);
}

async function readResponseBody(response: Response): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > MAX_FETCH_BYTES) {
      throw new Error("Response body too large");
    }
    chunks.push(value);
  }

  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

async function webSearch(query: string, limit = 5): Promise<{ query: string; results: Array<{ title: string; url: string; snippet: string }> }> {
  const safeLimit = Math.max(1, Math.min(limit, 10));
  const url = `https://api.duckduckgo.com/?format=json&no_redirect=1&no_html=1&skip_disambig=1&q=${encodeURIComponent(query)}`;
  const response = await withTimeout(
    fetch(url, {
      headers: {
        "user-agent": USER_AGENT
      }
    }),
    FETCH_TIMEOUT_MS,
    "search"
  );

  if (!response.ok) {
    throw new Error(`search request failed: ${response.status}`);
  }

  const payload = (await response.json()) as {
    Heading?: string;
    AbstractText?: string;
    AbstractURL?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
  };

  const rows: Array<{ title: string; url: string; snippet: string }> = [];

  if (payload.AbstractText && payload.AbstractURL) {
    rows.push({
      title: payload.Heading || query,
      url: payload.AbstractURL,
      snippet: payload.AbstractText
    });
  }

  for (const topic of payload.RelatedTopics ?? []) {
    if (rows.length >= safeLimit) break;
    if (topic.Text && topic.FirstURL) {
      rows.push({
        title: topic.Text.split(" - ")[0],
        url: topic.FirstURL,
        snippet: topic.Text
      });
    }
    for (const nested of topic.Topics ?? []) {
      if (rows.length >= safeLimit) break;
      if (nested.Text && nested.FirstURL) {
        rows.push({
          title: nested.Text.split(" - ")[0],
          url: nested.FirstURL,
          snippet: nested.Text
        });
      }
    }
  }

  return { query, results: rows.slice(0, safeLimit) };
}

async function webFetch(url: string, maxChars = DEFAULT_MAX_CHARS): Promise<{ url: string; content: string }> {
  const safeMaxChars = Math.max(500, Math.min(maxChars, MAX_FETCH_CHARS));
  const safeUrl = await assertPublicUrl(url);
  const response = await withTimeout(fetchTextWithRedirects(safeUrl, MAX_REDIRECTS), FETCH_TIMEOUT_MS, "fetch");

  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status}`);
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("text/") && !contentType.includes("json") && !contentType.includes("xml")) {
    throw new Error(`unsupported content type: ${contentType || "unknown"}`);
  }

  const body = await withTimeout(readResponseBody(response), FETCH_TIMEOUT_MS, "read");
  const text = stripHtml(body).slice(0, safeMaxChars);
  return { url: safeUrl.toString(), content: text };
}

export function createTools(availableSkills: SkillMetadata[]) {
  return {
    load_skill: tool({
      description: "Load a named skill and return its instructions to the reasoning context.",
      inputSchema: z.object({
        skill_name: z.string().min(1)
      }),
      execute: async ({ skill_name }) => {
        const meta = findSkillByName(skill_name, availableSkills);
        if (!meta) {
          return {
            ok: false,
            error: `Unknown skill: ${skill_name}`,
            available_skills: availableSkills.map((skill) => skill.name)
          };
        }

        const [skill] = await loadSkillsByName([meta.name], availableSkills);

        return {
          ok: true,
          skill_name: skill.name,
          description: skill.description,
          location: `${skill.skillPath}/SKILL.md`,
          instructions: skill.body
        };
      }
    }),
    web_search: tool({
      description: "Search the web for a query and return top results.",
      inputSchema: z.object({
        query: z.string().min(2),
        limit: z.number().int().min(1).max(10).optional()
      }),
      execute: async ({ query, limit }) => {
        try {
          return await webSearch(query, limit);
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "search failed"
          };
        }
      }
    }),
    web_fetch: tool({
      description: "Fetch and extract readable text from a URL.",
      inputSchema: z.object({
        url: z.string().url(),
        max_chars: z.number().int().min(500).max(MAX_FETCH_CHARS).optional()
      }),
      execute: async ({ url, max_chars }) => {
        try {
          return await webFetch(url, max_chars);
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "fetch failed"
          };
        }
      }
    })
  };
}
