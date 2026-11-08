import http from "node:http";
import type { Readable } from "node:stream";

// Module overview: a small Docker Engine API client over the local unix
// socket. It uses `node:http`, so the Docker provider needs no SDK.

const API_VERSION = "v1.43";
const DEFAULT_SOCKET_PATH = "/var/run/docker.sock";

/** Error response from the Docker Engine API. */
export class DockerApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(`Docker API error status=${statusCode}: ${message}`);
    this.name = "DockerApiError";
    this.statusCode = statusCode;
  }
}

/** One Docker Engine API request. */
export interface DockerRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "HEAD";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body, or raw bytes such as a tar archive. */
  body?: unknown;
  signal?: AbortSignal;
}

/** Return the unix socket path of the Docker daemon from `DOCKER_HOST`. */
function dockerSocketPath(): string {
  const host = process.env.DOCKER_HOST?.trim();
  if (!host) return DEFAULT_SOCKET_PATH;
  if (!host.startsWith("unix://")) {
    throw new Error(
      `The Docker sandbox provider supports only unix sockets. DOCKER_HOST is ${host}`,
    );
  }
  return host.slice("unix://".length);
}

function requestPath(input: DockerRequest): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const query = params.toString();
  return `/${API_VERSION}${input.path}${query ? `?${query}` : ""}`;
}

/** Send one request and return the response stream with its status. */
export function dockerStream(
  input: DockerRequest,
): Promise<http.IncomingMessage> {
  input.signal?.throwIfAborted();
  const raw =
    input.body instanceof Uint8Array ? Buffer.from(input.body) : undefined;
  const json =
    input.body !== undefined && !raw ? JSON.stringify(input.body) : undefined;
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: dockerSocketPath(),
      // The daemon closes idle connections. A reused keep-alive socket then
      // fails with EPIPE, so each request opens its own connection.
      agent: false,
      path: requestPath(input),
      method: input.method ?? "GET",
      headers: {
        ...(json ? { "content-type": "application/json" } : undefined),
        ...(raw ? { "content-type": "application/x-tar" } : undefined),
      },
      signal: input.signal,
    });
    request.on("response", resolve);
    request.on("error", reject);
    request.end(raw ?? json);
  });
}

/** Read a whole response stream into one buffer. */
export async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function errorFrom(response: http.IncomingMessage): Promise<never> {
  const body = (await readStream(response)).toString("utf8");
  let message = body.trim() || response.statusMessage || "request failed";
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // Keep the raw body as the message.
  }
  throw new DockerApiError(response.statusCode ?? 0, message);
}

/** Send one request and return its body. Error statuses throw `DockerApiError`. */
export async function dockerRequest(input: DockerRequest): Promise<Buffer> {
  const response = await dockerStream(input);
  if ((response.statusCode ?? 0) >= 400) return await errorFrom(response);
  return await readStream(response);
}

/** Send one request and parse its JSON body. */
export async function dockerJson<T>(input: DockerRequest): Promise<T> {
  const body = await dockerRequest(input);
  return (body.length > 0 ? JSON.parse(body.toString("utf8")) : {}) as T;
}

/** Send one request and return the response stream. Error statuses throw. */
export async function dockerOkStream(
  input: DockerRequest,
): Promise<http.IncomingMessage> {
  const response = await dockerStream(input);
  if ((response.statusCode ?? 0) >= 400) return await errorFrom(response);
  return response;
}
