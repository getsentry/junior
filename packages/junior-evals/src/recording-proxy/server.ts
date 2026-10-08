/**
 * The server of the recording proxy. See `README.md` in this directory.
 *
 * The proxy is a forward proxy. It intercepts HTTPS with its own
 * certificate authority (`certificates.ts`). It gives each request that a
 * rule matches to the recorder (`recorder.ts`). Other requests go live
 * without a change, and their responses stream.
 *
 * It sends requests only to the `allow` origins. It refuses other origins
 * with HTTP 403 and sends nothing. The upstream host always comes from
 * `allow`, never from the client. Only the path comes from the client.
 *
 * Each response has an `x-recording-proxy` header: `replayed`, `live`,
 * `missed` (`replay` mode had no recording), or `passthrough` (no rule
 * matched).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { isIP, type Socket } from "node:net";
import tls from "node:tls";
import { createCertificateAuthority } from "./certificates.ts";
import {
  createRecorder,
  type ProxyRequest,
  type Recorder,
} from "./recorder.ts";
import type { RecordingProxyAddress, RecordingProxyConfig } from "./types.ts";

/** The path prefix of the control API. */
export const CONTROL_PATH = "/__recording-proxy";

/** A proxy that runs in this process. Most callers use `client.ts`. */
export interface RecordingProxyServer extends RecordingProxyAddress {
  /** Stop the proxy. A session that is still open fails. */
  close(): Promise<void>;
}

/** Headers for one connection, which the proxy must not forward. */
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const AUTHORITY = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d{1,5})$/i;

/** Parse the allowed origins, by origin. A value that is not one throws. */
function parseOrigins(values: string[]): Map<string, URL> {
  return new Map(
    values.map((value) => {
      const origin = new URL(value);
      if (
        (origin.protocol !== "http:" && origin.protocol !== "https:") ||
        origin.origin !== value.replace(/\/$/, "")
      ) {
        throw new Error(`Recording proxy origin must be an origin: ${value}`);
      }
      return [origin.origin, origin];
    }),
  );
}

/** The `host:port` of an origin, with the default port of its scheme. */
function authorityOf(origin: URL): string {
  const port = origin.port || (origin.protocol === "https:" ? "443" : "80");
  return `${origin.hostname}:${port}`;
}

function readBody(stream: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

async function readJson<T>(incoming: http.IncomingMessage): Promise<T> {
  return JSON.parse((await readBody(incoming)).toString("utf8") || "{}") as T;
}

/** Compare tokens in constant time. */
function sameToken(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Send a request to an allowed origin. The host, port, and scheme come from
 * the configuration. Only the path comes from the client.
 */
function sendUpstream(
  origin: URL,
  request: ProxyRequest,
  extraHeaders: http.OutgoingHttpHeaders = {},
): Promise<http.IncomingMessage> {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined && !HOP_HEADERS.has(name)) headers[name] = value;
  }
  headers.host = origin.host;
  if (request.body.length > 0) {
    headers["content-length"] = String(request.body.length);
  } else {
    delete headers["content-length"];
  }
  Object.assign(headers, extraHeaders);
  const client = origin.protocol === "https:" ? https : http;
  // A URL keeps the brackets of an IPv6 host. A request option has none.
  const hostname = origin.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    const upstream = client.request(
      {
        protocol: origin.protocol,
        hostname,
        port: origin.port || undefined,
        servername: isIP(hostname) ? undefined : hostname,
        path: `${request.url.pathname}${request.url.search}`,
        method: request.method,
        headers,
      },
      resolve,
    );
    upstream.on("error", reject);
    upstream.end(request.body);
  });
}

/** Proxy one request to an allowed origin, through the recorder. */
async function proxyRequest(
  recorder: Recorder,
  origins: Map<string, URL>,
  incoming: http.IncomingMessage,
  outgoing: http.ServerResponse,
  tunnelOrigin: string | undefined,
): Promise<void> {
  const url = new URL(
    tunnelOrigin ? `${tunnelOrigin}${incoming.url}` : (incoming.url ?? ""),
  );
  const origin = origins.get(url.origin);
  if (!origin) {
    process.stderr.write(`[recording-proxy] Refused ${url.origin}\n`);
    outgoing.writeHead(403, { "content-type": "text/plain" });
    outgoing.end(`Recording proxy: ${url.origin} is not an allowed origin\n`);
    return;
  }
  const request: ProxyRequest = {
    method: incoming.method ?? "GET",
    url,
    headers: incoming.headers,
    body: await readBody(incoming),
  };
  const rule = recorder.ruleFor(request);

  if (!rule) {
    recorder.countPassthrough(origin.origin);
    const upstream = await sendUpstream(origin, request);
    outgoing.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, {
      ...upstream.headers,
      "x-recording-proxy": "passthrough",
    });
    outgoing.on("close", () => upstream.destroy());
    upstream.pipe(outgoing);
    return;
  }

  const response = await recorder.respond(rule, request, async () => {
    // Ask for a plain body, so the recording is readable.
    const upstream = await sendUpstream(origin, request, {
      "accept-encoding": "identity",
    });
    return {
      status: upstream.statusCode ?? 502,
      headers: upstream.headers,
      body: await readBody(upstream),
    };
  });
  outgoing.writeHead(response.status, {
    ...response.headers,
    "content-length": String(response.body.length),
    "x-recording-proxy": response.source,
  });
  outgoing.end(response.body);
}

/** Answer one request to the control API. See `README.md`. */
async function control(
  recorder: Recorder,
  token: string,
  incoming: http.IncomingMessage,
  outgoing: http.ServerResponse,
): Promise<void> {
  if (!sameToken(incoming.headers.authorization, `Bearer ${token}`)) {
    outgoing.writeHead(401).end();
    return;
  }
  const route = `${incoming.method} ${new URL(incoming.url ?? "/", "http://proxy").pathname}`;
  const json = (status: number, body: unknown) => {
    outgoing.writeHead(status, { "content-type": "application/json" });
    outgoing.end(JSON.stringify(body));
  };
  switch (route) {
    case `GET ${CONTROL_PATH}/stats`:
      json(200, recorder.stats());
      return;
    case `POST ${CONTROL_PATH}/session`: {
      const { name } = await readJson<{ name?: unknown }>(incoming);
      if (typeof name !== "string" || name === "") {
        json(400, { error: "name must be a string" });
        return;
      }
      await recorder.startSession(name);
      outgoing.writeHead(204).end();
      return;
    }
    case `POST ${CONTROL_PATH}/session/end`: {
      const { name, passed } = await readJson<{
        name?: unknown;
        passed?: unknown;
      }>(incoming);
      try {
        const missed = await recorder.endSession(String(name), passed === true);
        json(200, { missed });
      } catch (error) {
        json(409, { error: (error as Error).message });
      }
      return;
    }
    default:
      outgoing.writeHead(404).end();
  }
}

/** Start the proxy in this process, on a free port of `127.0.0.1`. */
export async function startRecordingProxy(
  config: RecordingProxyConfig,
): Promise<RecordingProxyServer> {
  const origins = parseOrigins(config.allow);
  const allowedAuthorities = new Set([...origins.values()].map(authorityOf));
  const recorder = createRecorder(config);
  const authority = await createCertificateAuthority();
  const token = randomBytes(24).toString("hex");
  // The origin of each tunnel. Absolute-form requests have no tunnel.
  const tunnelOrigins = new WeakMap<Socket, string>();
  const sockets = new Set<Socket>();

  const serve =
    (originOf: (incoming: http.IncomingMessage) => string | undefined) =>
    (incoming: http.IncomingMessage, outgoing: http.ServerResponse) => {
      proxyRequest(
        recorder,
        origins,
        incoming,
        outgoing,
        originOf(incoming),
      ).catch((error: unknown) => {
        if (!outgoing.headersSent) {
          outgoing.writeHead(502, { "content-type": "text/plain" });
        }
        outgoing.end(
          `Recording proxy error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    };

  // Requests inside a CONNECT tunnel. The tunnel gives the origin.
  const tunnelServer = http.createServer(
    serve((incoming) => tunnelOrigins.get(incoming.socket)),
  );
  const proxyAbsolute = serve(() => undefined);
  const server = http.createServer((incoming, outgoing) => {
    // A request to the proxy itself has a path. A proxied plain HTTP
    // request has an absolute URL.
    if (!incoming.url?.startsWith("/")) {
      proxyAbsolute(incoming, outgoing);
      return;
    }
    control(recorder, token, incoming, outgoing).catch((error: unknown) => {
      process.stderr.write(`[recording-proxy] Control failed: ${error}\n`);
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    });
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (request, socket: Socket, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const match = AUTHORITY.exec(request.url ?? "");
    if (!match) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const [, host, port] = match as unknown as [string, string, string];
    if (!allowedAuthorities.has(`${host.toLowerCase()}:${port}`)) {
      process.stderr.write(`[recording-proxy] Refused ${host}:${port}\n`);
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const open = async (first: Buffer) => {
      socket.unshift(first);
      // A TLS handshake starts with byte 0x16. Anything else is plain HTTP.
      if (first[0] !== 0x16) {
        tunnelOrigins.set(
          socket,
          `http://${host}${port === "80" ? "" : `:${port}`}`,
        );
        tunnelServer.emit("connection", socket);
        socket.resume();
        return;
      }
      const secure = new tls.TLSSocket(socket, {
        isServer: true,
        secureContext: await authority.contextFor(host),
        ALPNProtocols: ["http/1.1"],
      });
      secure.on("error", () => secure.destroy());
      tunnelOrigins.set(
        secure,
        `https://${host}${port === "443" ? "" : `:${port}`}`,
      );
      tunnelServer.emit("connection", secure);
    };
    const onFirst = (first: Buffer) => {
      socket.pause();
      open(first).catch(() => socket.destroy());
    };
    if (head.length > 0) onFirst(head);
    else socket.once("data", onFirst);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Recording proxy did not bind to a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    caCert: authority.caCert,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      tunnelServer.close();
      await recorder.close();
      await authority.close();
    },
  };
}
