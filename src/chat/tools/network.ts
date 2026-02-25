import dns from "node:dns/promises";
import net from "node:net";
import { FETCH_TIMEOUT_MS, USER_AGENT } from "@/chat/tools/constants";

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

export async function assertPublicUrl(rawUrl: string): Promise<URL> {
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

export function stripHtml(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
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

export async function fetchTextWithRedirects(url: URL, redirectsLeft: number): Promise<Response> {
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

export async function readResponseBody(response: Response, maxBytes: number): Promise<string> {
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
    if (total > maxBytes) {
      throw new Error("Response body too large");
    }
    chunks.push(value);
  }

  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}
