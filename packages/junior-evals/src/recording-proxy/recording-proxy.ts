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
 * A recording also keeps a short hash of each part of its request
 * (`request-parts.ts`). When a request has no recording, the proxy finds
 * the closest recording and reports the parts that differ. In `replay`
 * mode, a request without a recording fails with HTTP 412 and never goes
 * live.
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
 *   Returns `{"missed": 0}`, the requests of the session that had no
 *   recording in `replay` mode.
 * - `GET /__recording-proxy/stats`: the totals of the run.
 *
 * This file uses only Node built-ins and the `openssl` command, so it can
 * move out of this repository. `client.ts` starts it and talks to it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { createCertificates } from "./certificates.ts";
import {
  createRecordingIndex,
  pruneRecordings,
  readRecording,
  saveRecordings,
  type Recording,
} from "./recordings.ts";
import {
  describeParts,
  normalizeBody,
  requestParts,
  type KeyedRequest,
  type RequestParts,
} from "./request-parts.ts";

export type RecordingMode = "auto" | "off" | "record" | "replay";

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
   * - `replay`: replay a request that has a recording. Fail other requests
   *   with HTTP 412. Nothing goes live, and nothing is recorded.
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
  /**
   * A directory for debugging misses. For each request that has no
   * recording, the proxy writes the request as the key sees it, and its
   * diagnosis, to `<requestDirectory>/<rule>/<key>.json`. Compare the
   * files of two runs to see what changes. The files contain request
   * bodies, such as prompts, so do not commit them.
   */
  requestDirectory?: string;
}

/** A request that a rule matched, but that had no recording. */
export interface RecordingMiss {
  rule: string;
  /** The session of the request. */
  session?: string;
  /** The recording file that the request needed, relative to `directory`. */
  file: string;
  /** The recording with the most equal parts, relative to `directory`. */
  closest?: string;
  /** The parts that differ from `closest`. */
  differs: string[];
}

/** The totals of a proxy run, from `GET /__recording-proxy/stats`. */
export interface RecordingRunStats {
  /**
   * Replayed and live requests by rule name. `missed` counts the requests
   * that `replay` mode failed, because they had no recording.
   */
  counts: Record<string, { live: number; missed: number; replayed: number }>;
  /** The requests without a recording, in order. The first 500 are kept. */
  misses: RecordingMiss[];
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

interface Session {
  name: string;
  /** Recordings by file. `undefined` marks a replayed recording. */
  recordings: Map<string, Recording | undefined>;
  /** Files that the session replayed. They stay used if it fails. */
  replayed: Set<string>;
  /** Requests that `replay` mode failed. */
  missed: number;
}

const MAX_MISSES = 500;

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

/** The key headers of a request, in the order of the rule. */
function keyHeaders(
  rule: RecordingRule,
  headers: http.IncomingHttpHeaders,
): Record<string, string> {
  return Object.fromEntries(
    (rule.key?.headers ?? []).map((name) => [
      name,
      String(headers[name] ?? ""),
    ]),
  );
}

/** The recording key of a request. */
function recordingKey(rule: RecordingRule, request: KeyedRequest): string {
  const parts = [RECORDING_VERSION, rule.name, request.method, request.url];
  for (const [name, value] of Object.entries(request.headers)) {
    parts.push(`${name}: ${value}`);
  }
  parts.push(normalizeBody(request.body, rule.key?.ignore ?? []));
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
  parts: RequestParts,
  session: string | undefined,
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
    session,
    request: { method, url, parts },
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
      config.rules.map((rule) => [
        rule.name,
        { live: 0, missed: 0, replayed: 0 },
      ]),
    ),
    misses: [],
    written: 0,
    discarded: 0,
    passthrough: {},
  };
  // The origin of each tunnel. Absolute-form requests have no origin.
  const tunnelOrigins = new WeakMap<Socket, string>();
  const sockets = new Set<Socket>();

  // The request parts of the recordings, by rule name.
  const indexes = new Map(
    config.rules.map((rule) => [
      rule.name,
      createRecordingIndex(path.join(config.directory, rule.name)),
    ]),
  );
  const relative = (file: string) => path.relative(config.directory, file);

  /** Write recordings, and add them to the index. */
  const save = async (recordings: Array<[string, Recording]>) => {
    stats.written += await saveRecordings(recordings);
    for (const [file, recording] of recordings) {
      await indexes
        .get(path.basename(path.dirname(file)))
        ?.add(file, recording);
    }
  };

  /**
   * Report a request that has no recording. Compare it with the closest
   * recording, from the same session when there is one.
   */
  const diagnose = async (
    rule: RecordingRule,
    file: string,
    parts: RequestParts,
    request: KeyedRequest,
    current: Session | undefined,
  ) => {
    const closest = await indexes.get(rule.name)!.closest(parts, current?.name);
    const miss: RecordingMiss = {
      rule: rule.name,
      session: current?.name,
      file: relative(file),
      closest: closest && relative(closest.candidate.file),
      differs: closest?.differs ?? [],
    };
    if (stats.misses.length < MAX_MISSES) stats.misses.push(miss);
    const where = current ? ` in "${current.name}"` : "";
    const why = closest
      ? `closest is ${miss.closest}, which differs at ${describeParts(miss.differs)}`
      : "no recording to compare";
    process.stderr.write(
      `[recording-proxy] No ${rule.name} recording${where}: ${why}\n`,
    );
    if (config.requestDirectory) {
      const normalized = normalizeBody(request.body, rule.key?.ignore ?? []);
      let body: unknown = normalized;
      try {
        body = JSON.parse(normalized);
      } catch {
        // Keep the text of a body that is not JSON.
      }
      const target = path.join(config.requestDirectory, miss.file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(
        target,
        `${JSON.stringify({ ...miss, request: { ...request, body } }, null, 2)}\n`,
      );
    }
  };

  /**
   * Keep a recording that a request used. `write` marks a recording to
   * write: a live one, or a replayed one that gets its request parts.
   */
  const keep = async (
    file: string,
    recording: Recording,
    write: boolean,
    replayed: boolean,
  ) => {
    if (session) {
      if (replayed) session.replayed.add(file);
      // A recording to write wins over a replay of the same file.
      if (write || !session.recordings.has(file)) {
        session.recordings.set(file, write ? recording : undefined);
      }
      return;
    }
    used.add(file);
    if (write) await save([[file, recording]]);
  };

  /** End the session. Returns its requests that `replay` mode failed. */
  const endSession = async (passed: boolean): Promise<number> => {
    if (!session) return 0;
    const ended = session;
    session = undefined;
    const live = [...ended.recordings].filter(
      (entry): entry is [string, Recording] => entry[1] !== undefined,
    );
    if (!passed) {
      stats.discarded += live.length;
      // A failed test can still show that a recording is in use.
      for (const file of ended.replayed) used.add(file);
      return ended.missed;
    }
    for (const file of ended.recordings.keys()) used.add(file);
    await save(live);
    return ended.missed;
  };

  const handle = async (
    incoming: http.IncomingMessage,
    outgoing: http.ServerResponse,
    tunnelOrigin: string | undefined,
  ) => {
    const method = incoming.method ?? "GET";
    const current = session;
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
    const keyed: KeyedRequest = {
      body: body.toString("utf8"),
      headers: keyHeaders(rule, incoming.headers),
      method,
      url: url.href,
    };
    const file = path.join(
      config.directory,
      rule.name,
      `${recordingKey(rule, keyed)}.json`,
    );
    const parts = requestParts(keyed, rule.key?.ignore ?? []);
    if (recordingMode === "auto" || recordingMode === "replay") {
      const recording = await readRecording(file);
      if (recording) {
        counts.replayed += 1;
        // An older recording has no request parts. Add them, so that miss
        // diagnosis can compare with it. `replay` mode writes nothing.
        const backfill = !recording.request.parts && recordingMode === "auto";
        await keep(
          file,
          backfill
            ? {
                writtenAt: recording.writtenAt,
                session: recording.session ?? current?.name,
                request: { ...recording.request, parts },
                response: recording.response,
              }
            : recording,
          backfill,
          true,
        );
        writeRecording(outgoing, recording, "replayed");
        return;
      }
      await diagnose(rule, file, parts, keyed, current);
      if (recordingMode === "replay") {
        counts.missed += 1;
        if (current) current.missed += 1;
        outgoing.writeHead(412, {
          "content-type": "text/plain",
          "x-recording-proxy": "missed",
        });
        outgoing.end(
          `Recording proxy: no ${rule.name} recording for this request in replay mode. Run in auto mode to record it.\n`,
        );
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
      parts,
      current?.name,
      await sendUpstream(allowed, requestPath, method, headers, body),
    );
    // Never record a temporary failure or a response the client aborted.
    if (!clientGone && !isTemporaryStatus(recording.response.status)) {
      await keep(file, recording, true, false);
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
      session = {
        name: String(name ?? ""),
        recordings: new Map(),
        replayed: new Set(),
        missed: 0,
      };
      outgoing.writeHead(204).end();
      return;
    }
    if (incoming.method === "POST" && pathname === SESSION_END_PATH) {
      const { passed } = (await readJson(incoming)) as { passed?: unknown };
      const missed = await endSession(passed === true);
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ missed }));
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
