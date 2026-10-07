/**
 * A recording HTTP proxy for tests.
 *
 * Clients send their traffic through this proxy with `HTTPS_PROXY` or an
 * undici `ProxyAgent`. The proxy intercepts HTTPS with its own certificate
 * authority, so a client must trust `caCert`. A list of rules decides which
 * requests the proxy records and replays. Other requests go live without a
 * change.
 *
 * The proxy sends requests only to the `origins` of its configuration. It
 * refuses a request to any other origin with HTTP 403 and sends nothing.
 * The upstream request uses the host of the configured origin, never a host
 * from the client.
 *
 * The key of a request is the hash of its rule, method, URL, and body. JSON
 * bodies are compared with sorted keys. The `ignore` patterns of a rule
 * remove changing values, such as times, from the body before the hash.
 *
 * Modes of a rule:
 *
 * - `off`: the rule does nothing.
 * - `auto`: a request with a recording gets the recorded response. Other
 *   requests go live, and the proxy records them.
 * - `record`: every request goes live, and the proxy records it again.
 *
 * Clients must send proxy credentials with `secret` as the password, for
 * example `http://<session>:<secret>@127.0.0.1:<port>`. The control API
 * needs `Authorization: Bearer <secret>`. Without the secret, the proxy
 * sends no request, so other local processes cannot use it as an open proxy.
 * The proxy listens only on 127.0.0.1.
 *
 * A session groups the requests of one test. The client names the session
 * with the user name of the proxy credentials. The proxy keeps the recordings of a
 * session in memory until the client commits or discards the session through
 * the control API. Commit after a passing test, so a bad sample is never
 * replayed. A request without a session is written at once. A commit writes
 * replayed recordings again with the same content, so file times show which
 * recordings a run used.
 *
 * Each response has an `x-recording-proxy` header: `replayed`, `live` (a
 * live response that a rule records), or `passthrough` (no rule matched).
 *
 * Control API, on the proxy URL:
 *
 * - `GET /__recording-proxy/sessions/<id>`: replay and live counts by rule.
 * - `POST /__recording-proxy/sessions/<id>/commit`: write the recordings.
 * - `POST /__recording-proxy/sessions/<id>/discard`: drop the recordings.
 * - `GET /__recording-proxy/stats`: the counts of the whole run, and how
 *   many recordings the run wrote new or changed.
 *
 * This file uses only Node built-ins and the `openssl` command. It imports
 * nothing else, so it can move out of this repository. Run it with
 * `node recording-proxy.ts <config.json>`, or start it from code with
 * `spawnRecordingProxy()` or `startRecordingProxy()`.
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

export type RecordingMode = "auto" | "off" | "record";

/** One kind of traffic that the proxy records. */
export interface RecordingRule {
  name: string;
  mode: RecordingMode;
  /** Match only this method, such as `POST`. */
  method?: string;
  /** Match only URLs that start with this text. */
  urlPrefix?: string;
  /** Match only requests with these header values. Names are lowercase. */
  headers?: Record<string, string>;
  /** Regular expression sources. The key ignores their matches in the body. */
  ignore?: string[];
  /**
   * Request headers that are part of the key, with lowercase names. Use
   * this when a header changes the response, such as a model id header.
   */
  keyHeaders?: string[];
}

export interface RecordingProxyConfig {
  /** The directory of the recordings. Each rule has a subdirectory. */
  directory: string;
  /**
   * The only origins that the proxy sends requests to, such as
   * `https://ai-gateway.vercel.sh`. This is an allow list.
   */
  origins: string[];
  rules: RecordingRule[];
}

/** Replay and live counts of a session, by rule name. */
// A type alias, so the counts fit JSON metadata.
export type RecordingCounts = Record<
  string,
  { live: number; replayed: number }
>;

/** The totals of a proxy run, from `GET /__recording-proxy/stats`. */
export interface RecordingRunStats {
  /** Replayed and live requests of all sessions, by rule. */
  counts: RecordingCounts;
  /** Recordings that a commit wrote and that were new or changed. */
  written: number;
  /** Recordings that a discard dropped, because their test failed. */
  discarded: number;
  /**
   * Requests that matched no rule, by origin. These went live and were not
   * recorded. Use this to find traffic that a rule misses.
   */
  passthrough: Record<string, number>;
}

/** A running recording proxy. */
export interface RecordingProxy {
  /** The proxy URL, such as `http://127.0.0.1:1234`. */
  url: string;
  /** The PEM certificate of the authority that signs intercepted hosts. */
  caCert: string;
  /**
   * The password of the proxy credentials and the bearer token of the
   * control API. Without it, the proxy sends no request.
   */
  secret: string;
  close(): Promise<void>;
}

interface Recording {
  writtenAt: string;
  request: { method: string; url: string };
  response: {
    body: string;
    /** `base64` for a body that is not text, such as an image. */
    bodyEncoding: "base64" | "utf8";
    headers: Record<string, string>;
    status: number;
    statusText: string;
  };
}

interface Session {
  counts: RecordingCounts;
  pending: Map<string, Recording>;
}

interface Target {
  /** The origin of a tunnel. Absolute-form requests have no origin. */
  origin?: string;
  session?: string;
}

/** Change this to make every recording a miss. */
const RECORDING_VERSION = "http-v1";
const CONTROL_PREFIX = "/__recording-proxy/sessions/";
const STATS_PATH = "/__recording-proxy/stats";
/** Response headers that a recording keeps. Other headers change each run. */
const RECORDED_HEADERS = ["content-type", "location"];
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
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
const AUTHORITY = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d{1,5})$/i;

/** The `host:port` of an origin, with the default port of its scheme. */
function authorityOf(origin: URL): string {
  const port = origin.port || (origin.protocol === "https:" ? "443" : "80");
  return `${origin.hostname}:${port}`;
}

/** Parse the allowed origins. A value that is not an origin is an error. */
function parseOrigins(values: string[]): URL[] {
  return values.map((value) => {
    const origin = new URL(value);
    if (
      (origin.protocol !== "http:" && origin.protocol !== "https:") ||
      origin.origin !== value.replace(/\/$/, "")
    ) {
      throw new Error(`Recording proxy origin must be an origin: ${value}`);
    }
    return origin;
  });
}

/** Statuses that are never recorded, because they are temporary. */
const isTemporaryStatus = (status: number) => status === 429 || status >= 500;

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, _stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${stderr || error}`));
      else resolve();
    });
  });
}

/**
 * Create a certificate authority, and sign one certificate for each host
 * when a client first connects to it.
 */
async function createCertificates(directory: string) {
  const caKey = path.join(directory, "ca.key");
  const caCertPath = path.join(directory, "ca.crt");
  const hostKey = path.join(directory, "host.key");
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    caCertPath,
    "-days",
    "7",
    "-subj",
    "/CN=Recording proxy CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  await run("openssl", ["genrsa", "-out", hostKey, "2048"]);
  const hostKeyPem = await readFile(hostKey, "utf8");
  const contexts = new Map<string, Promise<tls.SecureContext>>();

  const sign = async (host: string): Promise<tls.SecureContext> => {
    const name = createHash("sha256").update(host).digest("hex").slice(0, 16);
    const csr = path.join(directory, `${name}.csr`);
    const extensions = path.join(directory, `${name}.ext`);
    const cert = path.join(directory, `${name}.crt`);
    const altName = isIP(host.replace(/^\[|\]$/g, ""))
      ? `IP:${host.replace(/^\[|\]$/g, "")}`
      : `DNS:${host}`;
    await writeFile(
      extensions,
      `subjectAltName=${altName}\nextendedKeyUsage=serverAuth\n`,
    );
    await run("openssl", [
      "req",
      "-new",
      "-key",
      hostKey,
      "-subj",
      "/CN=Recording proxy host",
      "-out",
      csr,
    ]);
    await run("openssl", [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      caCertPath,
      "-CAkey",
      caKey,
      "-set_serial",
      `0x${randomBytes(8).toString("hex")}`,
      "-days",
      "7",
      "-extfile",
      extensions,
      "-out",
      cert,
    ]);
    return tls.createSecureContext({
      cert: await readFile(cert, "utf8"),
      key: hostKeyPem,
    });
  };

  return {
    caCert: await readFile(caCertPath, "utf8"),
    contextFor(host: string): Promise<tls.SecureContext> {
      let context = contexts.get(host);
      if (!context) {
        context = sign(host);
        contexts.set(host, context);
      }
      return context;
    },
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

/** The recording key of a request. */
export function recordingKey(
  rule: Pick<RecordingRule, "ignore" | "keyHeaders" | "name">,
  request: {
    body: string;
    headers?: http.IncomingHttpHeaders;
    method: string;
    url: string;
  },
): string {
  let body: string;
  try {
    body = request.body ? stableStringify(JSON.parse(request.body)) : "";
  } catch {
    body = request.body;
  }
  for (const pattern of rule.ignore ?? []) {
    body = body.replace(new RegExp(pattern, "g"), "<ignored>");
  }
  const parts = [RECORDING_VERSION, rule.name, request.method, request.url];
  for (const name of rule.keyHeaders ?? []) {
    parts.push(`${name}: ${String(request.headers?.[name] ?? "")}`);
  }
  parts.push(body);
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

function matches(
  rule: RecordingRule,
  method: string,
  url: string,
  headers: http.IncomingHttpHeaders,
): boolean {
  if (rule.mode === "off") return false;
  if (rule.method && rule.method !== method) return false;
  if (rule.urlPrefix && !url.startsWith(rule.urlPrefix)) return false;
  return Object.entries(rule.headers ?? {}).every(
    ([name, value]) => headers[name] === value,
  );
}

/** Read `<session>:<secret>` proxy credentials. */
function credentialsFrom(
  header: string | undefined,
): { secret: string; session?: string } | undefined {
  const [scheme, token] = header?.split(" ") ?? [];
  if (scheme?.toLowerCase() !== "basic" || !token) return undefined;
  const decoded = Buffer.from(token, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return undefined;
  const user = decoded.slice(0, separator);
  return {
    secret: decoded.slice(separator + 1),
    ...(user ? { session: decodeURIComponent(user) } : {}),
  };
}

/** Compare secrets in constant time. */
function sameSecret(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(stream: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function forwardHeaders(
  headers: http.IncomingHttpHeaders,
  origin: URL,
  body: Buffer,
): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_HEADERS.has(name)) result[name] = value;
  }
  result.host = origin.host;
  if (body.length > 0) result["content-length"] = String(body.length);
  else delete result["content-length"];
  return result;
}

/**
 * Send a request to an allowed origin. The host, port, and scheme come from
 * the configuration. Only the path comes from the client.
 */
function sendUpstream(
  origin: URL,
  requestPath: string,
  method: string,
  headers: http.OutgoingHttpHeaders,
  body: Buffer,
): Promise<http.IncomingMessage> {
  const client = origin.protocol === "https:" ? https : http;
  // A URL keeps the brackets of an IPv6 host. A request option has none.
  const hostname = origin.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    const request = client.request(
      {
        protocol: origin.protocol,
        hostname,
        port: origin.port || undefined,
        servername: isIP(hostname) ? undefined : hostname,
        path: requestPath,
        method,
        headers,
      },
      resolve,
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function toRecording(
  method: string,
  url: string,
  response: http.IncomingMessage,
): Promise<Recording> {
  const body = await readBody(response);
  const contentType = response.headers["content-type"];
  const isText = /^text\/|json|xml/i.test(contentType ?? "");
  const headers: Record<string, string> = {};
  for (const name of RECORDED_HEADERS) {
    const value = response.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  return {
    writtenAt: new Date().toISOString(),
    request: { method, url },
    response: {
      body: isText ? body.toString("utf8") : body.toString("base64"),
      bodyEncoding: isText ? "utf8" : "base64",
      headers,
      status: response.statusCode ?? 502,
      statusText: response.statusMessage ?? "",
    },
  };
}

function writeRecording(
  target: http.ServerResponse,
  { response }: Recording,
  source: "live" | "replayed",
): void {
  const body = NULL_BODY_STATUSES.has(response.status)
    ? Buffer.alloc(0)
    : Buffer.from(response.body, response.bodyEncoding);
  target.writeHead(response.status, response.statusText || undefined, {
    ...response.headers,
    "content-length": String(body.length),
    "x-recording-proxy": source,
  });
  target.end(body);
}

async function readRecording(file: string): Promise<Recording | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Recording;
  } catch {
    return undefined;
  }
}

/** Write recordings. Returns how many were new or changed. */
async function saveRecordings(
  recordings: Map<string, Recording>,
): Promise<number> {
  const changed = await Promise.all(
    [...recordings].map(async ([file, recording]) => {
      const content = `${JSON.stringify(recording, null, 2)}\n`;
      const previous = await readFile(file, "utf8").catch(() => undefined);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      return previous !== content;
    }),
  );
  return changed.filter(Boolean).length;
}

/** Start the proxy in this process. */
export async function startRecordingProxy(
  config: RecordingProxyConfig,
): Promise<RecordingProxy> {
  const origins = parseOrigins(config.origins);
  const allowedAuthorities = new Set(origins.map(authorityOf));
  const certificateDir = await mkdtemp(path.join(tmpdir(), "recording-proxy-"));
  const certificates = await createCertificates(certificateDir);
  // Only a client with this secret can make the proxy send requests.
  const secret = randomBytes(24).toString("hex");
  const sessions = new Map<string, Session>();
  const emptyCounts = (): RecordingCounts =>
    Object.fromEntries(
      config.rules.map((rule) => [rule.name, { live: 0, replayed: 0 }]),
    );
  const stats: RecordingRunStats = {
    counts: emptyCounts(),
    written: 0,
    discarded: 0,
    passthrough: {},
  };
  const targets = new WeakMap<Socket, Target>();
  const sockets = new Set<Socket>();

  const sessionFor = (id: string): Session => {
    let session = sessions.get(id);
    if (!session) {
      session = { counts: emptyCounts(), pending: new Map() };
      sessions.set(id, session);
    }
    return session;
  };

  const keep = async (
    sessionId: string | undefined,
    file: string,
    recording: Recording,
  ) => {
    if (sessionId) sessionFor(sessionId).pending.set(file, recording);
    else stats.written += await saveRecordings(new Map([[file, recording]]));
  };

  const handle = async (
    incoming: http.IncomingMessage,
    outgoing: http.ServerResponse,
    target: Target,
  ) => {
    const method = incoming.method ?? "GET";
    const url = new URL(
      target.origin ? `${target.origin}${incoming.url}` : (incoming.url ?? ""),
    );
    const allowed = origins.find((origin) => origin.origin === url.origin);
    if (!allowed) {
      process.stderr.write(`[recording-proxy] Refused ${url.origin}\n`);
      outgoing.writeHead(403, { "content-type": "text/plain" });
      outgoing.end(`Recording proxy: ${url.origin} is not an allowed origin\n`);
      return;
    }
    const requestPath = `${url.pathname}${url.search}`;
    const body = await readBody(incoming);
    const headers = forwardHeaders(incoming.headers, allowed, body);
    const rule = config.rules.find((entry) =>
      matches(entry, method, url.href, incoming.headers),
    );

    if (!rule) {
      stats.passthrough[url.origin] = (stats.passthrough[url.origin] ?? 0) + 1;
      const response = await sendUpstream(
        allowed,
        requestPath,
        method,
        headers,
        body,
      );
      outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, {
        ...response.headers,
        "x-recording-proxy": "passthrough",
      });
      outgoing.on("close", () => response.destroy());
      response.pipe(outgoing);
      return;
    }

    const counts = [
      stats.counts[rule.name],
      target.session ? sessionFor(target.session).counts[rule.name] : undefined,
    ].filter((entry) => entry !== undefined);
    const key = recordingKey(rule, {
      body: body.toString("utf8"),
      headers: incoming.headers,
      method,
      url: url.href,
    });
    const file = path.join(config.directory, rule.name, `${key}.json`);
    if (rule.mode === "auto") {
      const recording = await readRecording(file);
      if (recording) {
        for (const entry of counts) entry.replayed += 1;
        await keep(target.session, file, recording);
        writeRecording(outgoing, recording, "replayed");
        return;
      }
    }

    for (const entry of counts) entry.live += 1;
    let clientGone = false;
    outgoing.on("close", () => {
      if (!outgoing.writableFinished) clientGone = true;
    });
    // Ask for a plain body, so the recording is readable.
    headers["accept-encoding"] = "identity";
    const recording = await toRecording(
      method,
      url.href,
      await sendUpstream(allowed, requestPath, method, headers, body),
    );
    // Never record a temporary failure or a response the client aborted.
    if (!clientGone && !isTemporaryStatus(recording.response.status)) {
      await keep(target.session, file, recording);
    }
    writeRecording(outgoing, recording, "live");
  };

  const serve =
    (targetOf: (incoming: http.IncomingMessage) => Target) =>
    (incoming: http.IncomingMessage, outgoing: http.ServerResponse) => {
      handle(incoming, outgoing, targetOf(incoming)).catch((error: unknown) => {
        if (!outgoing.headersSent) {
          outgoing.writeHead(502, { "content-type": "text/plain" });
        }
        outgoing.end(
          `Recording proxy error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    };

  const control = async (
    incoming: http.IncomingMessage,
    outgoing: http.ServerResponse,
  ) => {
    if (!sameSecret(incoming.headers.authorization, `Bearer ${secret}`)) {
      outgoing.writeHead(401).end();
      return;
    }
    const pathname = new URL(incoming.url ?? "/", "http://proxy").pathname;
    if (incoming.method === "GET" && pathname === STATS_PATH) {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(stats));
      return;
    }
    if (!pathname.startsWith(CONTROL_PREFIX)) {
      outgoing.writeHead(404).end();
      return;
    }
    const [id, action] = pathname
      .slice(CONTROL_PREFIX.length)
      .split("/")
      .map(decodeURIComponent);
    if (!id) {
      outgoing.writeHead(404).end();
      return;
    }
    if (incoming.method === "GET" && action === undefined) {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(sessionFor(id).counts));
      return;
    }
    if (incoming.method === "POST" && action === "commit") {
      stats.written += await saveRecordings(sessionFor(id).pending);
    }
    if (incoming.method === "POST" && action === "discard") {
      stats.discarded += sessionFor(id).pending.size;
    }
    if (
      incoming.method === "POST" &&
      (action === "commit" || action === "discard")
    ) {
      sessions.delete(id);
      outgoing.writeHead(204).end();
      return;
    }
    outgoing.writeHead(404).end();
  };

  // Requests inside a tunnel. The tunnel gives the origin and the session.
  const tunnelServer = http.createServer(
    serve((incoming) => targets.get(incoming.socket) ?? {}),
  );
  const server = http.createServer((incoming, outgoing) => {
    if (incoming.url?.startsWith("/")) {
      control(incoming, outgoing).catch(() => {
        if (!outgoing.headersSent) outgoing.writeHead(500);
        outgoing.end();
      });
      return;
    }
    // An absolute-form request for a plain HTTP URL.
    const credentials = credentialsFrom(
      incoming.headers["proxy-authorization"],
    );
    if (!sameSecret(credentials?.secret, secret)) {
      outgoing.writeHead(407, { "proxy-authenticate": "Basic" }).end();
      return;
    }
    serve(() => ({ session: credentials?.session }))(incoming, outgoing);
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (request, socket: Socket, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const authority = AUTHORITY.exec(request.url ?? "");
    if (!authority) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const [, host, port] = authority as unknown as [string, string, string];
    const credentials = credentialsFrom(request.headers["proxy-authorization"]);
    if (!sameSecret(credentials?.secret, secret)) {
      socket.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n",
      );
      return;
    }
    if (!allowedAuthorities.has(`${host.toLowerCase()}:${port}`)) {
      process.stderr.write(`[recording-proxy] Refused ${host}:${port}\n`);
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const session = credentials?.session;
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const start = async (first: Buffer) => {
      // A TLS handshake starts with byte 0x16. Anything else is plain HTTP.
      if (first[0] !== 0x16) {
        socket.unshift(first);
        targets.set(socket, {
          origin: `http://${host}${port === "80" ? "" : `:${port}`}`,
          session,
        });
        tunnelServer.emit("connection", socket);
        socket.resume();
        return;
      }
      const secureContext = await certificates.contextFor(host);
      socket.unshift(first);
      const secure = new tls.TLSSocket(socket, {
        isServer: true,
        secureContext,
        ALPNProtocols: ["http/1.1"],
      });
      secure.on("error", () => secure.destroy());
      targets.set(secure, {
        origin: `https://${host}${port === "443" ? "" : `:${port}`}`,
        session,
      });
      tunnelServer.emit("connection", secure);
    };
    const onFirst = (first: Buffer) => {
      socket.pause();
      start(first).catch(() => socket.destroy());
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
    caCert: certificates.caCert,
    secret,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      tunnelServer.close();
      await rm(certificateDir, { force: true, recursive: true });
    },
  };
}

/**
 * Start the proxy in a child process, so the traffic of the caller cannot
 * reach it through mocks in the same process.
 */
export async function spawnRecordingProxy(
  config: RecordingProxyConfig,
): Promise<RecordingProxy> {
  const configDir = await mkdtemp(
    path.join(tmpdir(), "recording-proxy-config-"),
  );
  const configPath = path.join(configDir, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      fileURLToPath(import.meta.url),
      configPath,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const ready = await new Promise<{
    caCert: string;
    secret: string;
    url: string;
  }>((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`Recording proxy exited with code ${code}`)),
    );
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const line = output.split("\n")[0];
      if (output.includes("\n") && line) resolve(JSON.parse(line));
    });
  });
  return {
    ...ready,
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.kill("SIGTERM");
        });
      }
      await rm(configDir, { force: true, recursive: true });
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Usage: recording-proxy.ts <config.json>");
  const config = JSON.parse(
    await readFile(configPath, "utf8"),
  ) as RecordingProxyConfig;
  const proxy = await startRecordingProxy(config);
  process.stdout.write(
    `${JSON.stringify({ caCert: proxy.caCert, secret: proxy.secret, url: proxy.url })}\n`,
  );
  const stop = () => {
    proxy.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
