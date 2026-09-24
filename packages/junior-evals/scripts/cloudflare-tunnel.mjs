#!/usr/bin/env node
/**
 * Own CI tunnel allocation, connector lifetime, and cleanup on the runner.
 * Child environments omit Cloudflare credentials. This is not process isolation.
 * Local evals still use Quick Tunnels without this script.
 */
import { spawn } from "node:child_process";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import dns from "node:dns/promises";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const API = "https://api.cloudflare.com/client/v4";
const PORT = 18787;

function required(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

/** Install the latest official Linux x64 release, checked against its asset digest. */
export async function installCloudflared(env = process.env) {
  const dir = path.join(required(env, "RUNNER_TEMP"), "junior-cloudflared");
  const response = await fetch(
    "https://api.github.com/repos/cloudflare/cloudflared/releases/latest",
    {
      headers: env.GH_TOKEN ? { authorization: `Bearer ${env.GH_TOKEN}` } : {},
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok)
    throw new Error(`cloudflared release lookup: HTTP ${response.status}`);
  const release = await response.json();
  const asset = release.assets.find(
    (item) => item.name === "cloudflared-linux-amd64",
  );
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")) {
    throw new Error(
      "Latest cloudflared release has no Linux x64 SHA-256 digest",
    );
  }
  // Resolve latest once. Never combine a moving download URL with an older digest.
  const download = await fetch(asset.browser_download_url, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!download.ok)
    throw new Error(`cloudflared download: HTTP ${download.status}`);
  const bytes = Buffer.from(await download.arrayBuffer());
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== asset.digest) throw new Error("cloudflared SHA-256 mismatch");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const binary = path.join(dir, "cloudflared");
  await writeFile(binary, bytes, { mode: 0o700 });
  await chmod(binary, 0o700);
  await appendFile(required(env, "GITHUB_PATH"), `${dir}\n`);
  console.log(`Installed cloudflared ${release.tag_name} (${digest})`);
}

/** Keep errors useful without printing API responses that can contain credentials. */
async function request(env, method, resource, body, allowMissing = false) {
  const response = await fetch(`${API}${resource}`, {
    method,
    headers: {
      authorization: `Bearer ${required(env, "CLOUDFLARE_API_TOKEN")}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (allowMissing && response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(
      `Cloudflare ${method} ${resource}: HTTP ${response.status}`,
    );
  const result = await response.json();
  if (!result.success) {
    throw new Error(
      `Cloudflare ${method} ${resource} failed (codes: ${result.errors?.map((error) => error.code).join(", ")})`,
    );
  }
  return result.result;
}

function statePath(env) {
  return path.join(required(env, "RUNNER_TEMP"), "junior-eval-tunnel.json");
}

/** Bind cleanup state to the job and reject edits before any remote or local deletion. */
function stateSignature(state, env) {
  const scope = [
    env.GITHUB_REPOSITORY,
    env.GITHUB_RUN_ID,
    env.GITHUB_RUN_ATTEMPT,
    env.GITHUB_JOB,
    env.JUNIOR_EVAL_SHARD,
    statePath(env),
  ];
  return createHmac("sha256", required(env, "CLOUDFLARE_API_TOKEN"))
    .update(JSON.stringify([scope, state]))
    .digest("hex");
}

/** Remove only this invocation's records. Retain state if cleanup fails for a later retry. */
export async function cleanupTunnel(env = process.env) {
  let state;
  try {
    const saved = JSON.parse(await readFile(statePath(env), "utf8"));
    state = saved.state;
    if (
      typeof saved.signature !== "string" ||
      !/^[a-f0-9]{64}$/.test(saved.signature) ||
      !timingSafeEqual(
        Buffer.from(saved.signature, "hex"),
        Buffer.from(stateSignature(state, env), "hex"),
      ) ||
      state?.accountId !== required(env, "CLOUDFLARE_ACCOUNT_ID") ||
      state?.zoneId !== required(env, "CLOUDFLARE_ZONE_ID") ||
      !/^sentry-ci-[a-f0-9]{24}$/.test(state?.name ?? "") ||
      state.hostname !==
        `${state.name}.${required(env, "CLOUDFLARE_TUNNEL_BASE_DOMAIN")}` ||
      state.tokenFile !==
        path.join(required(env, "RUNNER_TEMP"), `${state.name}.token`)
    ) {
      throw new Error(
        "Invalid eval tunnel cleanup state; no resources were deleted",
      );
    }
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const account = `/accounts/${state.accountId}/cfd_tunnel`;
  const dns = `/zones/${state.zoneId}/dns_records`;
  // Names are saved before allocation, so cleanup can recover a lost create response.
  // Attempt both remote deletions even if one API is unavailable.
  const results = await Promise.allSettled([
    (async () => {
      const records = await request(
        env,
        "GET",
        `${dns}?type=CNAME&name=${encodeURIComponent(state.hostname)}`,
      );
      for (const record of records.filter(
        (item) => item.name === state.hostname,
      )) {
        await request(env, "DELETE", `${dns}/${record.id}`, undefined, true);
      }
    })(),
    (async () => {
      const tunnels = await request(
        env,
        "GET",
        `${account}?is_deleted=false&name=${encodeURIComponent(state.name)}`,
      );
      for (const tunnel of tunnels.filter((item) => item.name === state.name)) {
        await request(
          env,
          "DELETE",
          `${account}/${tunnel.id}/connections`,
          undefined,
          true,
        );
        await request(
          env,
          "DELETE",
          `${account}/${tunnel.id}`,
          undefined,
          true,
        );
      }
    })(),
    rm(state.tokenFile, { force: true }),
  ]);
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length)
    throw new AggregateError(
      errors,
      `Cleanup failed for ${state.name}; run cleanup again`,
    );
  await rm(statePath(env));
  console.log(`Removed eval tunnel ${state.name}`);
}

/** Allocate a remote-managed tunnel and one exact DNS record, with no shared routes. */
export async function createTunnel(env = process.env) {
  required(env, "CLOUDFLARE_API_TOKEN");
  const accountId = required(env, "CLOUDFLARE_ACCOUNT_ID");
  const zoneId = required(env, "CLOUDFLARE_ZONE_ID");
  const domain = required(env, "CLOUDFLARE_TUNNEL_BASE_DOMAIN");
  if (!/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)) {
    throw new Error(
      "CLOUDFLARE_TUNNEL_BASE_DOMAIN must be a DNS name, not a URL",
    );
  }
  const hash = createHash("sha256")
    .update(
      [
        env.GITHUB_RUN_ID,
        env.GITHUB_RUN_ATTEMPT,
        env.GITHUB_JOB,
        env.JUNIOR_EVAL_SHARD,
        randomUUID(),
      ].join(":"),
    )
    .digest("hex")
    .slice(0, 24);
  const name = `sentry-ci-${hash}`;
  const hostname = `${name}.${domain}`;
  const tokenFile = path.join(required(env, "RUNNER_TEMP"), `${name}.token`);
  const state = { accountId, zoneId, name, hostname, tokenFile };
  // Signing protects persisted targets from edits, not from code that can read the API token.
  // Exclusive creation prevents accidentally replacing a previous invocation's cleanup state.
  await writeFile(
    statePath(env),
    JSON.stringify({ state, signature: stateSignature(state, env) }),
    { mode: 0o600, flag: "wx" },
  );
  console.log(`Allocating eval tunnel ${name} at https://${hostname}`);
  try {
    const account = `/accounts/${accountId}/cfd_tunnel`;
    const tunnel = await request(env, "POST", account, {
      name,
      config_src: "cloudflare",
    });
    if (!tunnel.id || !tunnel.token)
      throw new Error("Cloudflare returned no tunnel ID or token");
    if (env.GITHUB_ACTIONS === "true")
      console.log(`::add-mask::${tunnel.token}`);
    await writeFile(tokenFile, tunnel.token, { mode: 0o600, flag: "wx" });
    await request(env, "PUT", `${account}/${tunnel.id}/configurations`, {
      config: {
        ingress: [
          { hostname, service: `http://127.0.0.1:${PORT}` },
          { service: "http_status:404" },
        ],
      },
    });
    const record = await request(env, "POST", `/zones/${zoneId}/dns_records`, {
      type: "CNAME",
      name: hostname,
      content: `${tunnel.id}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
    });
    console.log(
      `Created DNS record ${record.id}: ${record.name} -> ${record.content} (proxied=${record.proxied})`,
    );
    return { baseUrl: `https://${hostname}`, tokenFile };
  } catch (error) {
    try {
      await cleanupTunnel(env);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Tunnel allocation and cleanup failed",
      );
    }
    throw error;
  }
}

function childEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !key.startsWith("CLOUDFLARE_") &&
        !key.startsWith("TUNNEL_") &&
        key !== "GH_TOKEN",
    ),
  );
}

function exited(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

/** Stop the entire child process group, including pnpm and Vitest descendants. */
async function stop(child, done) {
  if (!child?.pid) return;
  const signal = (value) => {
    try {
      process.kill(-child.pid, value);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 5_000);
  try {
    await done;
  } finally {
    clearTimeout(timer);
    signal("SIGKILL");
  }
}

/** Publish the new name before recursive lookups can cache a negative answer. */
async function waitForTunnelDns(baseUrl, domain, signal) {
  const hostname = new URL(baseUrl).hostname;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  const resolvers = [];
  const createResolver = () => {
    const resolver = new dns.Resolver({ timeout: 2_000, tries: 1 });
    resolvers.push(resolver);
    return resolver;
  };
  const cancel = () => resolvers.forEach((resolver) => resolver.cancel());
  deadline.addEventListener("abort", cancel, { once: true });
  let lastError;
  try {
    const discovery = createResolver();
    // A deeper base domain can use the parent zone's nameservers.
    let zone = domain;
    let nameservers;
    while (!nameservers) {
      deadline.throwIfAborted();
      try {
        nameservers = await discovery.resolveNs(zone);
      } catch (error) {
        if (
          !["ENODATA", "ENOTFOUND"].includes(error.code) ||
          !zone.includes(".")
        )
          throw error;
        zone = zone.slice(zone.indexOf(".") + 1);
      }
    }
    const authorities = await Promise.all(
      nameservers.map(async (name) => {
        const addresses = await discovery.resolve4(name);
        const resolver = createResolver();
        resolver.setServers(addresses);
        return { name, resolver };
      }),
    );
    if (!authorities.length) throw new Error(`No nameservers for ${domain}`);
    console.log(`Waiting for DNS publication of ${hostname}`);
    while (true) {
      deadline.throwIfAborted();
      const results = await Promise.allSettled(
        authorities.map(async ({ name, resolver }) => {
          // Check both record types. Recursive clients can query either first.
          await Promise.all([
            resolver.resolve4(hostname),
            resolver.resolve6(hostname).catch((error) => {
              // IPv6 can be disabled. NODATA is valid; NXDOMAIN is not.
              if (error.code !== "ENODATA") throw error;
            }),
          ]);
          return name;
        }),
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (!failures.length) {
        console.log(
          `DNS published on all ${authorities.length} nameservers for ${hostname}`,
        );
        return;
      }
      for (const { reason } of failures) {
        if (
          ![
            "ENOTFOUND",
            "ENODATA",
            "ETIMEOUT",
            "ESERVFAIL",
            "ECONNREFUSED",
          ].includes(reason.code)
        )
          throw reason;
        lastError = reason;
      }
      await delay(1_000, undefined, { signal: deadline });
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new Error(`DNS publication failed for ${hostname}`, {
      cause: lastError ?? error,
    });
  } finally {
    deadline.removeEventListener("abort", cancel);
    cancel();
  }
}

/** Compare DNS answers before cleanup removes the evidence. Diagnostics never change the exit code. */
async function reportTunnelDns(baseUrl, domain) {
  const hostname = new URL(baseUrl).hostname;
  const resolver = new dns.Resolver({ timeout: 2_000, tries: 1 });
  resolver.setServers(["1.1.1.1"]);
  const report = async (label, query) => {
    let timer;
    try {
      const result = await Promise.race([
        query(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("diagnostic timeout")),
            8_000,
          );
        }),
      ]);
      console.error(`Tunnel DNS ${label}: ${JSON.stringify(result)}`);
    } catch (error) {
      console.error(`Tunnel DNS ${label}: ${error.code ?? error.message}`);
    } finally {
      clearTimeout(timer);
    }
  };
  await Promise.all([
    report("system lookup", () => dns.lookup(hostname, { all: true })),
    report("1.1.1.1 A", () => resolver.resolve4(hostname)),
    report("1.1.1.1 AAAA", () => resolver.resolve6(hostname)),
    report("authoritative", async () => {
      const nameservers = await resolver.resolveNs(domain);
      return Promise.all(
        nameservers.map(async (name) => {
          const addresses = await resolver.resolve4(name);
          const authoritative = new dns.Resolver({ timeout: 2_000, tries: 1 });
          authoritative.setServers(addresses);
          try {
            return { name, addresses: await authoritative.resolve4(hostname) };
          } catch (error) {
            return { name, error: error.code ?? error.message };
          }
        }),
      );
    }),
  ]);
}

/** Run one eval command, then remove the connector, DNS record, and tunnel. */
export async function runWithTunnel(command, env = process.env) {
  if (!command.length)
    throw new Error("Usage: cloudflare-tunnel.mjs run <command> [args...]");
  let allocated = false;
  let publicUrl;
  let connector;
  let connectorDone;
  let child;
  let childDone;
  const abort = new AbortController();
  const interrupted = new Promise((resolve) => {
    abort.signal.addEventListener("abort", () => resolve({ code: 130 }), {
      once: true,
    });
  });
  const onSignal = () => abort.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const errors = [];
  let code = 1;
  try {
    const tunnel = await createTunnel(env);
    allocated = true;
    publicUrl = tunnel.baseUrl;
    await waitForTunnelDns(
      publicUrl,
      env.CLOUDFLARE_TUNNEL_BASE_DOMAIN,
      abort.signal,
    );
    abort.signal.throwIfAborted();
    connector = spawn(
      "cloudflared",
      [
        "tunnel",
        "--no-autoupdate",
        "--loglevel",
        "error",
        "--protocol",
        "http2",
        "run",
        "--token-file",
        tunnel.tokenFile,
      ],
      {
        detached: true,
        stdio: ["ignore", "ignore", "inherit"],
        env: childEnvironment(env),
      },
    );
    connectorDone = exited(connector);
    child = spawn(command[0], command.slice(1), {
      detached: true,
      stdio: "inherit",
      env: {
        ...childEnvironment(env),
        JUNIOR_EVAL_EGRESS_URL: tunnel.baseUrl,
        JUNIOR_EVAL_EGRESS_PORT: String(PORT),
      },
    });
    childDone = exited(child);
    const result = await Promise.race([
      childDone,
      interrupted,
      connectorDone.then(() => {
        throw new Error("cloudflared exited while evals were running");
      }),
    ]);
    code = result.code ?? 1;
  } catch (error) {
    if (abort.signal.aborted) code = 130;
    else errors.push(error);
  } finally {
    // Try every cleanup operation. An API failure must not leave local children running.
    for (const task of [
      () => stop(child, childDone),
      () =>
        publicUrl && code !== 0 && !abort.signal.aborted
          ? reportTunnelDns(publicUrl, env.CLOUDFLARE_TUNNEL_BASE_DOMAIN)
          : undefined,
      () => stop(connector, connectorDone),
      () => (allocated ? cleanupTunnel(env) : undefined),
    ]) {
      try {
        await task();
      } catch (error) {
        errors.push(error);
      }
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  if (errors.length) {
    throw new AggregateError(
      errors,
      "Eval tunnel failed; cleanup state is retained if needed",
    );
  }
  return code;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [action, ...command] = process.argv.slice(2);
    if (action === "install") await installCloudflared();
    else if (action === "cleanup") await cleanupTunnel();
    else if (action === "run") process.exitCode = await runWithTunnel(command);
    else throw new Error("Usage: cloudflare-tunnel.mjs <install|run|cleanup>");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
