import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
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

function parseMappedIpv4FromIpv6(mapped: string): string | undefined {
  if (net.isIP(mapped) === 4) {
    return mapped;
  }

  const hexMatch = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hexMatch) {
    return undefined;
  }

  const high = Number.parseInt(hexMatch[1], 16);
  const low = Number.parseInt(hexMatch[2], 16);
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }

  // Link-local unicast is fe80::/10, not only fe80::/16.
  if (normalized.startsWith("fe")) {
    const third = normalized[2];
    if (third === "8" || third === "9" || third === "a" || third === "b") {
      return true;
    }
  }

  // IPv4-mapped IPv6 loopback/private ranges must be treated as private.
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    const mappedIpv4 = parseMappedIpv4FromIpv6(mapped);
    if (mappedIpv4 && isPrivateIpv4(mappedIpv4)) {
      return true;
    }
  }

  return false;
}

type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

function normalizeHostname(hostname: string): string {
  const lowered = hostname.toLowerCase();
  if (lowered.startsWith("[") && lowered.endsWith("]")) {
    return lowered.slice(1, -1);
  }
  return lowered;
}

async function resolvePublicHostname(hostname: string): Promise<ResolvedAddress[]> {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) {
    throw new Error("Could not resolve hostname");
  }

  const deduped = new Map<string, ResolvedAddress>();
  for (const record of records) {
    const family = record.family === 6 ? 6 : 4;
    if (family === 4 && isPrivateIpv4(record.address)) {
      throw new Error("Resolved to a private IPv4 address");
    }
    if (family === 6 && isPrivateIpv6(record.address)) {
      throw new Error("Resolved to a private IPv6 address");
    }
    deduped.set(`${family}:${record.address}`, { address: record.address, family });
  }

  return [...deduped.values()];
}

async function resolvePinnedAddresses(url: URL): Promise<ResolvedAddress[] | undefined> {
  const hostname = normalizeHostname(url.hostname);
  if (net.isIP(hostname) !== 0) {
    return undefined;
  }
  return resolvePublicHostname(hostname);
}

function createPinnedLookup(resolved: ResolvedAddress[]) {
  const fallback = resolved[0];
  return (
    _hostname: string,
    options: { family?: number | "IPv4" | "IPv6"; all?: boolean },
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number
    ) => void
  ) => {
    if (options?.all) {
      callback(
        null,
        resolved.map((entry) => ({
          address: entry.address,
          family: entry.family
        }))
      );
      return;
    }

    const requestedFamilyRaw = options?.family ?? 0;
    const requestedFamily = requestedFamilyRaw === "IPv4" ? 4 : requestedFamilyRaw === "IPv6" ? 6 : requestedFamilyRaw;
    const selected = resolved.find((entry) => requestedFamily === 0 || entry.family === requestedFamily) ?? fallback;
    callback(null, selected.address, selected.family);
  };
}

async function fetchWithPinnedLookup(url: URL, resolved: ResolvedAddress[] | undefined, signal: AbortSignal): Promise<Response> {
  if (!resolved) {
    return fetch(url, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        "user-agent": USER_AGENT
      }
    });
  }

  const client = url.protocol === "https:" ? https : http;
  const lookup = createPinnedLookup(resolved);
  return new Promise<Response>((resolve, reject) => {
    const request = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        ...(url.port ? { port: url.port } : {}),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        lookup,
        ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
        headers: {
          "user-agent": USER_AGENT,
          "accept-encoding": "identity"
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        });
        response.on("end", () => {
          signal.removeEventListener("abort", onAbort);
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) {
                headers.append(name, item);
              }
              continue;
            }
            if (typeof value === "string") {
              headers.set(name, value);
            }
          }

          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 500,
              headers
            })
          );
        });
      }
    );

    const onAbort = () => {
      request.destroy(new Error("fetch timed out"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    request.on("error", (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });

    request.end();
  });
}

export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  const parsed = new URL(rawUrl);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed");
  }

  const hostname = normalizeHostname(parsed.hostname);
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
    await resolvePublicHostname(hostname);
  }

  return parsed;
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
  const resolved = await resolvePinnedAddresses(url);
  const response = await fetchWithPinnedLookup(url, resolved, abortController.signal).finally(() => clearTimeout(timer));

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
