import http from "node:http";
import net from "node:net";
import { Duplex, Readable } from "node:stream";
import tls from "node:tls";
import type { KeyObject } from "node:crypto";
import {
  createLeafKey,
  issueLeafCertificate,
  loadEgressCa,
  type EgressCa,
} from "@/chat/sandbox/docker/certificates";
import { dockerJson } from "@/chat/sandbox/docker/api";
import type { SandboxContainer } from "@/chat/sandbox/docker/container";
import { runRawExec } from "@/chat/sandbox/docker/exec";
import { dockerSandboxDir } from "@/chat/sandbox/docker/settings";
import { logWarn } from "@/chat/logging";
import { matchesSandboxEgressDomain } from "@/chat/sandbox/egress/policy";
import { executeSandboxEgressRequest } from "@/chat/sandbox/egress/proxy";
import type { SandboxNetworkPolicy } from "@/chat/sandbox/workspace";

// Module overview: Docker sandbox egress.
//
// Outbound: `applyEgressPolicy` adds iptables rules in the sandbox container.
// They send all TCP traffic to ports 80 and 443 on public addresses to a proxy
// in this Junior process. Traffic from the agent's own inner containers takes
// the same path.
//
// Inbound: the proxy knows each sandbox by its IP on the sandbox's own Docker
// network. It reads the host name from TLS SNI or from the HTTP `Host` header,
// because the redirect hides the original address. It decrypts only
// credentialed and trace domains, with a leaf certificate from the egress CA.
// Credentialed requests go to the shared `executeSandboxEgressRequest`. Trace
// requests get their headers and go upstream. All other connections pass
// through unchanged.
//
// The proxy and its routes live in the process that applied the policy. This
// is the process that runs the sandbox's commands, and it also owns the
// auth-required signals that the egress engine writes. Each policy update
// points the sandbox's rules at this process's proxy.

const CHAIN = "JUNIOR_EGRESS";
/** Private destinations never go to the proxy. Provider domains are public. */
const DIRECT_RANGES = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
];
const MAX_PEEK_BYTES = 64 * 1024;
const PEEK_TIMEOUT_MS = 10_000;
const HOP_BY_HOP = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type EgressPolicy = Exclude<SandboxNetworkPolicy, "allow-all">;

interface Route {
  /** Container id. It is also the egress id that the credential token binds. */
  egressId: string;
  /** Container name. It is also the name of the container's own network. */
  name: string;
  policy: EgressPolicy;
}

interface Proxy {
  port: number;
  ca: EgressCa;
  leafKey: KeyObject;
  contexts: Map<string, tls.SecureContext>;
  routes: Map<string, Route>;
}

interface Connection {
  sourceIp: string;
  host: string;
  scheme: "http" | "https";
}

let proxyPromise: Promise<Proxy> | undefined;

/** Load the egress CA. Each sandbox trusts it. */
export async function egressCaPem(): Promise<string> {
  return (await loadEgressCa(dockerSandboxDir())).certPem;
}

/**
 * Return how the proxy handles a host, and the policy domain that it matched.
 * Upstream URLs use that domain, not the host name that the sandbox sent.
 */
function interceptMode(
  route: Route | undefined,
  host: string,
): { mode: "credential" | "trace"; domain: string } | undefined {
  const policy = route?.policy;
  const find = (domains: string[] | undefined) =>
    (domains ?? []).find((domain) => matchesSandboxEgressDomain(host, domain));
  const credentialDomain = find(policy?.credentialEgress?.domains);
  if (credentialDomain) return { mode: "credential", domain: credentialDomain };
  const traceDomain = find(policy?.traceHeaders?.domains);
  if (traceDomain) return { mode: "trace", domain: traceDomain };
  return undefined;
}

/**
 * Return the path and query of an origin-form request target.
 * An absolute or `//` target could name another host, so it is rejected.
 */
function originFormPath(target: string | undefined): string | undefined {
  if (
    !target?.startsWith("/") ||
    target.startsWith("//") ||
    /[\r\n#]/.test(target)
  ) {
    return undefined;
  }
  const url = new URL(target, "http://sandbox-request.local");
  return `${url.pathname}${url.search}`;
}

/** Return the SNI host name of a complete TLS ClientHello record. */
function parseSni(record: Buffer): string | undefined {
  let offset = 5 + 4 + 2 + 32;
  const read = (bytes: number) => {
    const value = record.readUIntBE(offset, bytes);
    offset += bytes;
    return value;
  };
  // Each skipped field is a length followed by that many bytes.
  const skip = (lengthBytes: number) => {
    const length = read(lengthBytes);
    offset += length;
  };
  try {
    skip(1); // session id
    skip(2); // cipher suites
    skip(1); // compression methods
    const extensionsLength = read(2);
    const end = offset + extensionsLength;
    while (offset + 4 <= end) {
      const type = read(2);
      const length = read(2);
      if (type === 0) {
        // server_name list: total length, name type, name length, name.
        offset += 3;
        const nameLength = read(2);
        return record.toString("ascii", offset, offset + nameLength);
      }
      offset += length;
    }
  } catch {
    // A short or malformed ClientHello has no usable SNI.
  }
  return undefined;
}

/** Read until the first TLS record or HTTP request head is complete. */
function peek(
  socket: net.Socket,
): Promise<{ data: Buffer; host?: string; scheme: "http" | "https" }> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const timer = setTimeout(
      () => finish(new Error("peek timeout")),
      PEEK_TIMEOUT_MS,
    );
    const finish = (error?: Error, host?: string) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", finish);
      socket.pause();
      if (error) reject(error);
      else resolve({ data, host, scheme: data[0] === 0x16 ? "https" : "http" });
    };
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data[0] === 0x16) {
        if (data.length < 5) return;
        const end = 5 + data.readUInt16BE(3);
        if (data.length >= end)
          return finish(undefined, parseSni(data.subarray(0, end)));
      } else {
        const head = data.indexOf("\r\n\r\n");
        if (head >= 0) {
          const match = /^host:[ \t]*([^\r\n:]+)/im.exec(
            data.toString("latin1", 0, head),
          );
          return finish(undefined, match?.[1]?.trim());
        }
      }
      if (data.length > MAX_PEEK_BYTES)
        finish(new Error("request head too large"));
    };
    socket.on("data", onData);
    socket.once("error", finish);
  });
}

function requestHeaders(rawHeaders: string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index] ?? "";
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers.append(name, rawHeaders[index + 1] ?? "");
  }
  return headers;
}

async function writeResponse(response: Response, res: http.ServerResponse) {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie" && !HOP_BY_HOP.has(name)) headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body) return void res.end();
  Readable.fromWeb(response.body as never).pipe(res);
}

/** Send a trace-domain request upstream with the policy's trace headers. */
async function forwardWithTraceHeaders(
  request: Request,
  route: Route,
): Promise<Response> {
  const headers = new Headers(request.headers);
  for (const [name, value] of Object.entries(
    route.policy.traceHeaders?.headers ?? {},
  )) {
    headers.set(name, value);
  }
  const upstream = await fetch(request.url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
    duplex: "half",
  } as RequestInit);
  // fetch decodes the body, so its encoding and length no longer apply.
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

async function handleRequest(
  proxy: Proxy,
  connection: Connection,
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  const route = proxy.routes.get(connection.sourceIp);
  const host = req.headers.host?.split(":")[0]?.toLowerCase();
  if (host !== connection.host) {
    res.writeHead(421).end("Host does not match the TLS server name");
    return;
  }
  const intercept = interceptMode(route, host);
  if (!route || !intercept) {
    res.writeHead(403).end("Sandbox egress route is gone");
    return;
  }
  const path = originFormPath(req.url);
  if (!path) {
    res.writeHead(400).end("Request target must be a path");
    return;
  }
  const upstreamUrl = new URL(
    `${connection.scheme}://${intercept.domain}${path}`,
  );
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(upstreamUrl, {
    method: req.method,
    headers: requestHeaders(req.rawHeaders),
    ...(hasBody
      ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" }
      : undefined),
  } as RequestInit);
  const response =
    intercept.mode === "credential"
      ? await executeSandboxEgressRequest({
          request,
          egressId: route.egressId,
          upstreamUrl,
          credentialToken: route.policy.credentialEgress?.credentialToken,
        })
      : await forwardWithTraceHeaders(request, route);
  await writeResponse(response, res);
}

function secureContext(proxy: Proxy, host: string): tls.SecureContext {
  let context = proxy.contexts.get(host);
  if (!context) {
    context = tls.createSecureContext({
      key: proxy.leafKey.export({ type: "pkcs8", format: "pem" }),
      cert: issueLeafCertificate(proxy.ca, host, proxy.leafKey),
    });
    proxy.contexts.set(host, context);
  }
  return context;
}

/**
 * Check that the route's container still has this address on its own network.
 * A removed sandbox's address can come back on a new sandbox network.
 */
async function ownsAddress(route: Route, sourceIp: string): Promise<boolean> {
  try {
    const details = await dockerJson<{
      State: { Running: boolean };
      NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
    }>({ path: `/containers/${route.egressId}/json` });
    return (
      details.State.Running &&
      details.NetworkSettings.Networks[route.name]?.IPAddress === sourceIp
    );
  } catch {
    return false;
  }
}

/**
 * Wrap a socket in a stream that first replays the bytes that `peek` read.
 * TLS and HTTP servers read a net.Socket's handle directly, so they would skip
 * bytes put back with `unshift`.
 */
function replay(socket: net.Socket, data: Buffer): Duplex {
  const stream = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk, encoding, callback) {
      socket.write(chunk, encoding, callback);
    },
    final(callback) {
      socket.end(callback);
    },
    destroy(error, callback) {
      socket.destroy(error ?? undefined);
      callback(error);
    },
  });
  stream.push(data);
  socket.on("data", (chunk) => {
    if (!stream.push(chunk)) socket.pause();
  });
  socket.on("end", () => stream.push(null));
  socket.on("error", (error) => stream.destroy(error));
  return stream;
}

function passThrough(
  socket: net.Socket,
  data: Buffer,
  host: string,
  port: number,
) {
  const upstream = net.connect({ host, port }, () => {
    upstream.write(data);
    socket.pipe(upstream);
    upstream.pipe(socket);
    socket.resume();
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

async function handleConnection(
  proxy: Proxy,
  server: http.Server,
  connections: WeakMap<object, Connection>,
  socket: net.Socket,
) {
  const sourceIp = (socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const route = proxy.routes.get(sourceIp);
  if (!route || !(await ownsAddress(route, sourceIp))) {
    logWarn("sandbox.egress.docker.unknown_source", {
      "client.address": sourceIp,
    });
    socket.destroy();
    return;
  }
  const { data, host: rawHost, scheme } = await peek(socket);
  const host = rawHost?.toLowerCase();
  if (!host) {
    // The redirect hides the original address, so a request without a host
    // name cannot go anywhere.
    socket.destroy();
    return;
  }
  if (!interceptMode(route, host)) {
    passThrough(socket, data, host, scheme === "https" ? 443 : 80);
    return;
  }
  const replayed = replay(socket, data);
  const target =
    scheme === "https"
      ? new tls.TLSSocket(replayed, {
          isServer: true,
          secureContext: secureContext(proxy, host),
          ALPNProtocols: ["http/1.1"],
        })
      : replayed;
  connections.set(target, { sourceIp, host, scheme });
  target.on("error", () => socket.destroy());
  server.emit("connection", target);
}

async function startProxy(): Promise<Proxy> {
  const proxy: Proxy = {
    port: 0,
    ca: await loadEgressCa(dockerSandboxDir()),
    leafKey: createLeafKey(),
    contexts: new Map(),
    routes: new Map(),
  };
  const connections = new WeakMap<object, Connection>();
  const server = http.createServer((req, res) => {
    const connection = connections.get(req.socket);
    if (!connection) return void res.writeHead(500).end();
    handleRequest(proxy, connection, req, res).catch((error: unknown) => {
      logWarn("sandbox.egress.docker.request_failed", {
        "error.message": error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });
  const listener = net.createServer((socket) => {
    handleConnection(proxy, server, connections, socket).catch(() =>
      socket.destroy(),
    );
  });
  // Bind every address: each sandbox reaches the proxy through the gateway of
  // its own network. The route table rejects every other source.
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "0.0.0.0", () => resolve());
  });
  listener.unref();
  proxy.port = (listener.address() as net.AddressInfo).port;
  return proxy;
}

function getProxy(): Promise<Proxy> {
  proxyPromise ??= startProxy().catch((error: unknown) => {
    proxyPromise = undefined;
    throw error;
  });
  return proxyPromise;
}

function rulesScript(target?: string): string {
  const lines = [
    "set -eu",
    `iptables -t nat -N ${CHAIN} 2>/dev/null || iptables -t nat -F ${CHAIN}`,
    `iptables -t nat -C OUTPUT -j ${CHAIN} 2>/dev/null || iptables -t nat -A OUTPUT -j ${CHAIN}`,
    // Traffic from the agent's inner containers arrives on other interfaces.
    `iptables -t nat -C PREROUTING ! -i eth0 -j ${CHAIN} 2>/dev/null || iptables -t nat -A PREROUTING ! -i eth0 -j ${CHAIN}`,
  ];
  if (target) {
    for (const range of DIRECT_RANGES) {
      lines.push(`iptables -t nat -A ${CHAIN} -d ${range} -j RETURN`);
    }
    // The kernel may lack the multiport match, so use one rule per port.
    for (const port of [80, 443]) {
      lines.push(
        `iptables -t nat -A ${CHAIN} -p tcp --dport ${port} -j DNAT --to-destination ${target}`,
      );
    }
  }
  return lines.join("\n");
}

function hasDomains(policy: EgressPolicy): boolean {
  return Boolean(
    policy.credentialEgress?.domains.length ||
    policy.traceHeaders?.domains.length,
  );
}

/**
 * Apply one network policy to a sandbox container.
 *
 * A policy with credentialed or trace domains sends the container's web
 * traffic to this process's proxy. `allow-all` removes the redirect.
 */
export async function applyEgressPolicy(
  container: SandboxContainer,
  policy: SandboxNetworkPolicy,
): Promise<void> {
  let target: string | undefined;
  if (policy !== "allow-all" && hasDomains(policy)) {
    const proxy = await getProxy();
    proxy.routes.set(container.ip, {
      egressId: container.id,
      name: container.name,
      policy,
    });
    target = `${container.gateway}:${proxy.port}`;
  } else if (proxyPromise) {
    (await proxyPromise).routes.delete(container.ip);
  }
  const result = await runRawExec(container.id, {
    cmd: ["sh", "-c", rulesScript(target)],
    root: true,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not apply the sandbox network policy: ${result.stderr.trim()}`,
    );
  }
}
