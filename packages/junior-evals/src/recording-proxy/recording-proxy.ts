/**
 * The server of the recording proxy. See `README.md` in this directory.
 *
 * The proxy is a forward proxy for tests. It intercepts HTTPS with its own
 * certificate authority. Rules decide which requests it records and
 * replays. Other requests go live without a change. It sends requests only
 * to the `allow` origins. It refuses other origins with HTTP 403 and sends
 * nothing. The upstream host always comes from `allow`, never from the
 * client.
 *
 * The key of a request is the hash of its rule, method, URL, and body. JSON
 * bodies are compared with sorted keys. A rule can add request headers to
 * the key and remove changing values, such as times, from the body.
 *
 * A session groups the requests of one test. One session is open at a
 * time. The proxy keeps the new recordings of a session in memory until the
 * session ends. A passed session writes them, and a failed session drops
 * them, so a bad sample is never replayed. A request outside a session is
 * written at once.
 *
 * Each response has an `x-recording-proxy` header: `replayed`, `live` (a
 * live response that a rule records), or `passthrough` (no rule matched).
 *
 * Control API, on the proxy URL, with `Authorization: Bearer <token>`:
 *
 * - `POST /__recording-proxy/session` with `{"name": "..."}`: open a
 *   session.
 * - `POST /__recording-proxy/session/end` with `{"passed": true}`: end it.
 * - `GET /__recording-proxy/stats`: the totals of the run.
 *
 * This file uses only Node built-ins and the `openssl` command, so it can
 * move out of this repository. `client.ts` starts it and talks to it.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
  /** The name of the rule. Its recordings are in `<directory>/<name>/`. */
  name: string;
  /** The requests of the rule. Each field that is set must match. */
  match: {
    /** The method, such as `POST`. */
    method?: string;
    /** The start of the URL, such as `https://ai-gateway.vercel.sh/`. */
    url?: string;
    /** Header values. Names are lowercase. */
    headers?: Record<string, string>;
  };
  /** How to build the key. The method, URL, and body are always in it. */
  key?: {
    /** Request headers that are also in the key. Names are lowercase. */
    headers?: string[];
    /** Regular expression sources. The key ignores their matches in the body. */
    ignore?: string[];
  };
}

export interface RecordingProxyConfig {
  /** The directory of the recordings. Each rule has a subdirectory. */
  directory: string;
  /**
   * - `auto`: replay a request that has a recording. Send other requests
   *   live and record them.
   * - `record`: send every request live and record it again.
   * - `off`: record and replay nothing.
   */
  mode: RecordingMode;
  /** The only origins that the proxy sends requests to. */
  allow: string[];
  rules: RecordingRule[];
  /**
   * A file. When the proxy stops, it writes the recordings that passed
   * sessions used to this file. Give these files to `pruneRecordings()`.
   */
  usedFile?: string;
}

/** The totals of a proxy run, from `GET /__recording-proxy/stats`. */
export interface RecordingRunStats {
  /** Replayed and live requests, by rule name. */
  counts: Record<string, { live: number; replayed: number }>;
  /** Recordings that the proxy wrote and that were new or changed. */
  written: number;
  /** New recordings that the proxy dropped, because their session failed. */
  discarded: number;
  /**
   * Requests that matched no rule, by origin. These went live and were not
   * recorded. Use this to find traffic that a rule misses.
   */
  passthrough: Record<string, number>;
}

/** A proxy that runs in this process. */
export interface RecordingProxyServer {
  /** The proxy URL, such as `http://127.0.0.1:1234`. */
  url: string;
  /** The PEM certificate of the authority that signs intercepted hosts. */
  caCert: string;
  /** The bearer token of the control API. */
  token: string;
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
  name: string;
  /** Recordings by file. `undefined` marks a replayed recording. */
  recordings: Map<string, Recording | undefined>;
}

/** Change this to make every recording a miss. */
const RECORDING_VERSION = "http-v1";
const SESSION_PATH = "/__recording-proxy/session";
const SESSION_END_PATH = "/__recording-proxy/session/end";
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
  rule: Pick<RecordingRule, "key" | "name">,
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
  for (const pattern of rule.key?.ignore ?? []) {
    body = body.replace(new RegExp(pattern, "g"), "<ignored>");
  }
  const parts = [RECORDING_VERSION, rule.name, request.method, request.url];
  for (const name of rule.key?.headers ?? []) {
    parts.push(`${name}: ${String(request.headers?.[name] ?? "")}`);
  }
  parts.push(body);
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

function matches(
  { match }: RecordingRule,
  method: string,
  url: string,
  headers: http.IncomingHttpHeaders,
): boolean {
  if (match.method && match.method !== method) return false;
  if (match.url && !url.startsWith(match.url)) return false;
  return Object.entries(match.headers ?? {}).every(
    ([name, value]) => headers[name] === value,
  );
}

/** Compare tokens in constant time. */
function sameToken(actual: string | undefined, expected: string): boolean {
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
  recordings: Iterable<[string, Recording]>,
): Promise<number> {
  const changed = await Promise.all(
    [...recordings].map(async ([file, recording]) => {
      const content = `${JSON.stringify(recording, null, 2)}\n`;
      const previous = await readFile(file, "utf8").catch(() => undefined);
      if (previous === content) return false;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      return true;
    }),
  );
  return changed.filter(Boolean).length;
}

/** Read a small JSON control request body. */
async function readJson(incoming: http.IncomingMessage): Promise<unknown> {
  const body = (await readBody(incoming)).toString("utf8");
  return body ? JSON.parse(body) : {};
}

/** Start the proxy in this process. Most callers use `client.ts`. */
export async function startRecordingProxy(
  config: RecordingProxyConfig,
): Promise<RecordingProxyServer> {
  const origins = parseOrigins(config.allow);
  const allowedAuthorities = new Set(origins.map(authorityOf));
  const recordingMode = config.mode;
  const certificateDir = await mkdtemp(path.join(tmpdir(), "recording-proxy-"));
  const certificates = await createCertificates(certificateDir);
  const token = randomBytes(24).toString("hex");
  let session: Session | undefined;
  // Recordings that passed sessions or requests outside a session used.
  const used = new Set<string>();
  const stats: RecordingRunStats = {
    counts: Object.fromEntries(
      config.rules.map((rule) => [rule.name, { live: 0, replayed: 0 }]),
    ),
    written: 0,
    discarded: 0,
    passthrough: {},
  };
  // The origin of each tunnel. Absolute-form requests have no origin.
  const tunnelOrigins = new WeakMap<Socket, string>();
  const sockets = new Set<Socket>();

  /** Keep a recording that a request used. */
  const keep = async (file: string, recording: Recording, live: boolean) => {
    if (session) {
      // A live recording wins over a replay of the same file.
      if (live || !session.recordings.has(file)) {
        session.recordings.set(file, live ? recording : undefined);
      }
      return;
    }
    used.add(file);
    if (live) stats.written += await saveRecordings([[file, recording]]);
  };

  const endSession = async (passed: boolean) => {
    if (!session) return;
    const ended = session;
    session = undefined;
    const live = [...ended.recordings].filter(
      (entry): entry is [string, Recording] => entry[1] !== undefined,
    );
    if (!passed) {
      stats.discarded += live.length;
      return;
    }
    for (const file of ended.recordings.keys()) used.add(file);
    stats.written += await saveRecordings(live);
  };

  const handle = async (
    incoming: http.IncomingMessage,
    outgoing: http.ServerResponse,
    tunnelOrigin: string | undefined,
  ) => {
    const method = incoming.method ?? "GET";
    const url = new URL(
      tunnelOrigin ? `${tunnelOrigin}${incoming.url}` : (incoming.url ?? ""),
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
    const rule =
      recordingMode === "off"
        ? undefined
        : config.rules.find((entry) =>
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

    const counts = stats.counts[rule.name]!;
    const key = recordingKey(rule, {
      body: body.toString("utf8"),
      headers: incoming.headers,
      method,
      url: url.href,
    });
    const file = path.join(config.directory, rule.name, `${key}.json`);
    if (recordingMode === "auto") {
      const recording = await readRecording(file);
      if (recording) {
        counts.replayed += 1;
        await keep(file, recording, false);
        writeRecording(outgoing, recording, "replayed");
        return;
      }
    }

    counts.live += 1;
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
      await keep(file, recording, true);
    }
    writeRecording(outgoing, recording, "live");
  };

  const serve =
    (originOf: (incoming: http.IncomingMessage) => string | undefined) =>
    (incoming: http.IncomingMessage, outgoing: http.ServerResponse) => {
      handle(incoming, outgoing, originOf(incoming)).catch((error: unknown) => {
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
    if (!sameToken(incoming.headers.authorization, `Bearer ${token}`)) {
      outgoing.writeHead(401).end();
      return;
    }
    const pathname = new URL(incoming.url ?? "/", "http://proxy").pathname;
    if (incoming.method === "GET" && pathname === STATS_PATH) {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(stats));
      return;
    }
    if (incoming.method === "POST" && pathname === SESSION_PATH) {
      const { name } = (await readJson(incoming)) as { name?: unknown };
      if (session) {
        // A client that stopped early never ended its session.
        process.stderr.write(
          `[recording-proxy] Session "${session.name}" did not end, so its new recordings were dropped\n`,
        );
        await endSession(false);
      }
      session = { name: String(name ?? ""), recordings: new Map() };
      outgoing.writeHead(204).end();
      return;
    }
    if (incoming.method === "POST" && pathname === SESSION_END_PATH) {
      const { passed } = (await readJson(incoming)) as { passed?: unknown };
      await endSession(passed === true);
      outgoing.writeHead(204).end();
      return;
    }
    outgoing.writeHead(404).end();
  };

  // Requests inside a tunnel. The tunnel gives the origin.
  const tunnelServer = http.createServer(
    serve((incoming) => tunnelOrigins.get(incoming.socket)),
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
    serve(() => undefined)(incoming, outgoing);
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
    if (!allowedAuthorities.has(`${host.toLowerCase()}:${port}`)) {
      process.stderr.write(`[recording-proxy] Refused ${host}:${port}\n`);
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const start = async (first: Buffer) => {
      // A TLS handshake starts with byte 0x16. Anything else is plain HTTP.
      if (first[0] !== 0x16) {
        socket.unshift(first);
        tunnelOrigins.set(
          socket,
          `http://${host}${port === "80" ? "" : `:${port}`}`,
        );
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
      tunnelOrigins.set(
        secure,
        `https://${host}${port === "443" ? "" : `:${port}`}`,
      );
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
    token,
    async close() {
      await endSession(false);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      tunnelServer.close();
      await rm(certificateDir, { force: true, recursive: true });
      if (config.usedFile) {
        const files = [...used]
          .map((file) => path.relative(config.directory, file))
          .sort();
        await writeFile(config.usedFile, files.map((f) => `${f}\n`).join(""));
      }
    },
  };
}

/**
 * Delete the recordings in `directory` that no used file lists. Each used
 * file comes from `usedFile` of one proxy run. Returns how many it deleted.
 * Give it the used files of every run that shares the directory, or it
 * deletes recordings that another run needs.
 */
export async function pruneRecordings(
  directory: string,
  usedFiles: string[],
): Promise<number> {
  const used = new Set<string>();
  for (const file of usedFiles) {
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      if (line) used.add(line);
    }
  }
  const recordings = (await readdir(directory, { recursive: true })).filter(
    (file) => file.endsWith(".json"),
  );
  const unused = recordings.filter((file) => !used.has(file));
  await Promise.all(unused.map((file) => rm(path.join(directory, file))));
  return unused.length;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "prune") {
    const [directory, ...usedFiles] = args;
    if (!directory || usedFiles.length === 0) {
      throw new Error(
        "Usage: recording-proxy.ts prune <directory> <used-file>...",
      );
    }
    const count = await pruneRecordings(directory, usedFiles);
    process.stdout.write(`Deleted ${count} unused recordings\n`);
  } else {
    if (!command) throw new Error("Usage: recording-proxy.ts <config.json>");
    const config = JSON.parse(
      await readFile(command, "utf8"),
    ) as RecordingProxyConfig;
    const proxy = await startRecordingProxy(config);
    process.stdout.write(
      `${JSON.stringify({ caCert: proxy.caCert, token: proxy.token, url: proxy.url })}\n`,
    );
    const stop = () => {
      proxy.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
}
