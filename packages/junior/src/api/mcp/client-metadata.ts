/**
 * Own MCP OAuth clients. Junior accepts only Client ID Metadata Documents
 * (CIMD): the `client_id` is an HTTPS URL, and the document at that URL
 * names the client and its redirect URIs. Junior has no client registration.
 */
import https from "node:https";
import net from "node:net";
import { z } from "zod";
import { isPublicAddress, publicAddressLookup } from "./public-address";
import { mcpStateKey, stateKeyHash, type McpState } from "./state";

const CLIENT_ID_MAX_LENGTH = 2_000;
const CLIENT_METADATA_MAX_BYTES = 5 * 1024;
const CLIENT_METADATA_TIMEOUT_MS = 5_000;
// A changed document takes effect after this time. It is not configurable.
const CLIENT_METADATA_CACHE_TTL_MS = 5 * 60 * 1000;
// The authorize endpoint is public, so a failed fetch is cached too. This
// limits how often one client ID can make Junior fetch a URL.
const INVALID_CLIENT_CACHE_TTL_MS = 60 * 1000;

// Not strict: this parses an external document, and CIMD allows more fields.
const clientMetadataDocumentSchema = z.object({
  client_id: z.string(),
  client_name: z.string().trim().min(1).max(200).optional(),
  redirect_uris: z.array(z.string().max(CLIENT_ID_MAX_LENGTH)).min(1).max(20),
  // Public clients only. Junior does not support client authentication.
  token_endpoint_auth_method: z.literal("none").optional(),
});

const mcpClientSchema = z
  .object({
    clientId: z.string().min(1),
    name: z.string().min(1).optional(),
    redirectUris: z.array(z.string()).min(1),
  })
  .strict();

const invalidClientSchema = z.object({ invalid: z.literal(true) }).strict();

const cachedClientSchema = z.union([mcpClientSchema, invalidClientSchema]);

type McpClient = z.output<typeof mcpClientSchema>;

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}

/**
 * Parse a CIMD client ID. It must be a canonical `https:` URL with a path,
 * no fragment, no credentials, and no loopback or private IP host.
 */
function parseClientId(value: string): URL | undefined {
  if (value.length > CLIENT_ID_MAX_LENGTH || value.includes("#")) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const hostname = stripBrackets(url.hostname);
  if (
    url.href !== value ||
    url.protocol !== "https:" ||
    url.pathname === "/" ||
    url.username ||
    url.password ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    (net.isIP(hostname) !== 0 && !isPublicAddress(hostname))
  ) {
    return undefined;
  }
  return url;
}

/**
 * Fetch one client metadata document. Redirects, non-200 responses, slow or
 * large responses, blocked addresses, and invalid JSON all give `undefined`,
 * because each one only means that the client is invalid.
 */
function fetchClientMetadataDocument(url: URL): Promise<unknown> {
  return new Promise((resolve) => {
    const request = https.request(
      url,
      {
        headers: { accept: "application/json" },
        // A pooled socket skips `lookup`, so each fetch opens its own socket.
        agent: false,
        lookup: publicAddressLookup,
        method: "GET",
        signal: AbortSignal.timeout(CLIENT_METADATA_TIMEOUT_MS),
      },
      (response) => {
        // `https.request` does not follow redirects, so a 3xx stops here.
        if (response.statusCode !== 200) {
          request.destroy();
          resolve(undefined);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > CLIENT_METADATA_MAX_BYTES) {
            request.destroy();
            resolve(undefined);
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            resolve(undefined);
          }
        });
        response.on("error", () => resolve(undefined));
      },
    );
    request.on("error", () => resolve(undefined));
    request.end();
  });
}

/**
 * Resolve a client from its CIMD URL. Return `undefined` when the client ID or
 * its document is invalid. Valid documents are cached for 5 minutes, and
 * failed fetches for 1 minute.
 */
export async function resolveMcpClient(
  state: McpState,
  clientId: string,
): Promise<McpClient | undefined> {
  const url = parseClientId(clientId);
  if (!url) return undefined;
  const key = mcpStateKey("client", stateKeyHash(clientId));
  const cached = await state.get(key);
  if (cached !== null && cached !== undefined) {
    const entry = cachedClientSchema.parse(cached);
    return "invalid" in entry ? undefined : entry;
  }

  const parsed = clientMetadataDocumentSchema.safeParse(
    await fetchClientMetadataDocument(url),
  );
  if (!parsed.success || parsed.data.client_id !== clientId) {
    await state.set(key, { invalid: true }, INVALID_CLIENT_CACHE_TTL_MS);
    return undefined;
  }
  const client = mcpClientSchema.parse({
    clientId,
    ...(parsed.data.client_name
      ? { name: parsed.data.client_name }
      : undefined),
    redirectUris: parsed.data.redirect_uris,
  });
  await state.set(key, client, CLIENT_METADATA_CACHE_TTL_MS);
  return client;
}

function isLoopbackHttp(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}

/**
 * Return true when a requested redirect URI is allowed for a client. The URI
 * must be `https:` or loopback `http:`, and must equal a registered URI. A
 * loopback URI may use any port (RFC 8252 section 7.3), because native
 * clients such as Claude Code listen on a random port.
 */
export function redirectUriMatches(
  registered: readonly string[],
  requested: string,
): boolean {
  let url: URL;
  try {
    url = new URL(requested);
  } catch {
    return false;
  }
  if (
    requested.includes("#") ||
    (url.protocol !== "https:" && !isLoopbackHttp(url))
  ) {
    return false;
  }
  return registered.some((entry) => {
    if (entry === requested) return true;
    if (!isLoopbackHttp(url)) return false;
    let candidate: URL;
    try {
      candidate = new URL(entry);
    } catch {
      return false;
    }
    return (
      isLoopbackHttp(candidate) &&
      candidate.hostname === url.hostname &&
      candidate.pathname === url.pathname &&
      candidate.search === url.search
    );
  });
}
