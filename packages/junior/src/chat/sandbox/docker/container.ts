import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import {
  DockerApiError,
  dockerJson,
  dockerRequest,
} from "@/chat/sandbox/docker/api";
import { runRawExec, SANDBOX_USER } from "@/chat/sandbox/docker/exec";
import {
  DOCKER_SANDBOX_LABEL,
  dockerSandboxExtraCaFile,
} from "@/chat/sandbox/docker/settings";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import { sleep } from "@/chat/sleep";

// Module overview: the lifecycle of one sandbox container.
//
// Each sandbox is a named, privileged container on its own Docker network. Its
// own network is required: on a shared bridge, a privileged sandbox can take
// another sandbox's IP and MAC address, and the egress proxy would then give
// it the other sandbox's credentials. Each network gets a subnet from
// `SUBNET_PREFIX`, so it never overlaps the default address pools that the
// sandbox's inner Docker daemon uses.

const SUBNET_PREFIX = "10.213";
const CA_ANCHOR_DIR = "/etc/pki/ca-trust/source/anchors";
/** Amazon Linux's combined CA bundle, rebuilt by `update-ca-trust`. */
const SYSTEM_CA_BUNDLE = "/etc/pki/tls/certs/ca-bundle.crt";
/** Runtimes that ignore the system trust store but read these env vars. */
const CA_BUNDLE_ENV = [
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_FILE",
  "CURL_CA_BUNDLE",
  "AWS_CA_BUNDLE",
];
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 100;

/**
 * PID 1 script of every sandbox container. `docker-init` runs it.
 *
 * It clears state that a snapshot or restart leaves behind, then stops the
 * container when its deadline passes. `extendTimeout` moves the deadline.
 * The ready file holds the start time of PID 1, so a check never sees the
 * ready file of an earlier start.
 */
const INIT_SCRIPT = `set -u
rm -f /var/run/docker.pid /run/junior/ready
mkdir -p /run/junior
echo $(( $(date +%s) + JUNIOR_SANDBOX_TIMEOUT_SECONDS )) > /run/junior/deadline
cut -d' ' -f22 /proc/1/stat > /run/junior/ready
trap 'exit 0' TERM INT
while :; do
  deadline=$(cat /run/junior/deadline 2>/dev/null || echo 0)
  [ "$(date +%s)" -ge "$deadline" ] && exit 0
  sleep 2 & wait $!
done
`;

/** A started sandbox container. */
export interface SandboxContainer {
  id: string;
  name: string;
  /** Container IP on its own network. The egress proxy uses it as identity. */
  ip: string;
  /** Host side of the container's network. The egress proxy listens here. */
  gateway: string;
}

interface ContainerInspect {
  Id: string;
  Name: string;
  State: { Running: boolean };
  NetworkSettings: {
    Networks: Record<string, { IPAddress: string; Gateway: string }>;
  };
}

/** Input for one new sandbox container. */
export interface CreateContainerInput {
  name: string;
  image: string;
  timeoutMs: number;
  /** Keep the container and its files after it stops. */
  persistent: boolean;
  vcpus?: number;
  signal?: AbortSignal;
}

function isStatus(error: unknown, status: number): boolean {
  return error instanceof DockerApiError && error.statusCode === status;
}

/** Return a sandbox name for a sandbox that the caller did not name. */
export function newSandboxName(): string {
  return `junior-${randomUUID()}`;
}

async function listSandboxResources<T>(
  kind: "containers" | "networks",
): Promise<T[]> {
  return await dockerJson<T[]>({
    path: kind === "containers" ? "/containers/json" : "/networks",
    query: {
      ...(kind === "containers" ? { all: true } : undefined),
      filters: JSON.stringify({ label: [DOCKER_SANDBOX_LABEL] }),
    },
  });
}

/** Remove sandbox networks whose container no longer exists. */
async function pruneNetworks(): Promise<void> {
  const containers = await listSandboxResources<{
    Labels: Record<string, string>;
  }>("containers");
  const used = new Set(
    containers.map((container) => container.Labels[DOCKER_SANDBOX_LABEL]),
  );
  const networks = await listSandboxResources<{
    Name: string;
    Labels: Record<string, string>;
  }>("networks");
  for (const network of networks) {
    if (used.has(network.Labels[DOCKER_SANDBOX_LABEL])) continue;
    await removeNetwork(network.Name);
  }
}

async function createNetwork(name: string, signal?: AbortSignal) {
  await pruneNetworks();
  const networks = await listSandboxResources<{
    IPAM: { Config: Array<{ Subnet?: string }> | null };
  }>("networks");
  const taken = new Set(
    networks.flatMap((network) =>
      (network.IPAM.Config ?? []).map((config) => config.Subnet),
    ),
  );
  for (let index = 0; index < 256; index += 1) {
    const subnet = `${SUBNET_PREFIX}.${index}.0/24`;
    if (taken.has(subnet)) continue;
    try {
      await dockerJson({
        method: "POST",
        path: "/networks/create",
        body: {
          Name: name,
          Driver: "bridge",
          CheckDuplicate: true,
          IPAM: { Config: [{ Subnet: subnet }] },
          Labels: { [DOCKER_SANDBOX_LABEL]: name },
        },
        signal,
      });
      return;
    } catch (error) {
      // Another process took this subnet first. Try the next one.
      if (error instanceof DockerApiError && /overlap/i.test(error.message)) {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`No free ${SUBNET_PREFIX}.x.0/24 subnet for sandbox ${name}`);
}

async function removeNetwork(name: string): Promise<void> {
  try {
    await dockerRequest({
      method: "DELETE",
      path: `/networks/${encodeURIComponent(name)}`,
    });
  } catch (error) {
    if (!isStatus(error, 404)) throw error;
  }
}

async function inspect(name: string, signal?: AbortSignal) {
  return await dockerJson<ContainerInspect>({
    path: `/containers/${encodeURIComponent(name)}/json`,
    signal,
  });
}

function toContainer(details: ContainerInspect): SandboxContainer {
  const name = details.Name.replace(/^\//, "");
  const network = details.NetworkSettings.Networks[name];
  if (!network?.IPAddress) {
    throw new Error(`Sandbox container ${name} has no address on its network`);
  }
  return {
    id: details.Id,
    name,
    ip: network.IPAddress,
    gateway: network.Gateway,
  };
}

async function waitUntilReady(id: string, signal?: AbortSignal) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await runRawExec(
      id,
      {
        cmd: [
          "sh",
          "-c",
          `[ "$(cat /run/junior/ready 2>/dev/null)" = "$(cut -d' ' -f22 /proc/1/stat)" ]`,
        ],
        root: true,
      },
      signal,
    );
    if (result.exitCode === 0) return;
    await sleep(READY_POLL_MS, signal);
  }
  throw new Error(`Sandbox container ${id} did not become ready`);
}

async function caCertificates(egressCaPem: string): Promise<string> {
  const extraFile = dockerSandboxExtraCaFile();
  const extra = extraFile ? await fs.readFile(extraFile, "utf8") : "";
  return `${egressCaPem.trim()}\n${extra.trim()}\n`;
}

/** Put the egress CA into the sandbox's system trust store. */
async function trustEgressCa(id: string, egressCaPem: string) {
  const pem = Buffer.from(await caCertificates(egressCaPem)).toString("base64");
  const anchor = `${CA_ANCHOR_DIR}/junior-docker-sandbox.pem`;
  const result = await runRawExec(id, {
    cmd: [
      "sh",
      "-c",
      [
        "set -eu",
        `printf '%s' '${pem}' | base64 -d > ${anchor}.new`,
        `if cmp -s ${anchor}.new ${anchor}; then rm ${anchor}.new; exit 0; fi`,
        `mv ${anchor}.new ${anchor}`,
        "update-ca-trust extract",
      ].join("\n"),
    ],
    root: true,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Could not trust the egress CA: ${result.stderr}`);
  }
}

async function start(name: string, signal?: AbortSignal) {
  try {
    await dockerRequest({
      method: "POST",
      path: `/containers/${encodeURIComponent(name)}/start`,
      signal,
    });
  } catch (error) {
    // 304 means that the container already runs.
    if (!isStatus(error, 304)) throw error;
  }
}

/**
 * Create and start one sandbox container, then wait until it is ready.
 *
 * A container that is not persistent removes itself when it stops, like a
 * Vercel Sandbox that is not persistent.
 */
export async function createContainer(
  input: CreateContainerInput,
  egressCaPem: string,
): Promise<SandboxContainer> {
  await createNetwork(input.name, input.signal);
  try {
    await dockerJson({
      method: "POST",
      path: "/containers/create",
      query: { name: input.name },
      body: {
        Image: input.image,
        Cmd: ["sh", "-c", INIT_SCRIPT],
        User: "root",
        WorkingDir: SANDBOX_WORKSPACE_ROOT,
        Env: [
          `JUNIOR_SANDBOX_TIMEOUT_SECONDS=${Math.ceil(input.timeoutMs / 1000)}`,
          ...CA_BUNDLE_ENV.map((name) => `${name}=${SYSTEM_CA_BUNDLE}`),
        ],
        Labels: { [DOCKER_SANDBOX_LABEL]: input.name },
        HostConfig: {
          Init: true,
          Privileged: true,
          AutoRemove: !input.persistent,
          NetworkMode: input.name,
          // The inner Docker daemon needs its own volume. On the container's
          // overlay root it falls back to the slow `vfs` storage driver.
          Mounts: [{ Type: "volume", Target: "/var/lib/docker" }],
          ...(input.vcpus ? { NanoCpus: input.vcpus * 1e9 } : undefined),
        },
      },
      signal: input.signal,
    });
  } catch (error) {
    await removeNetwork(input.name).catch(() => undefined);
    throw error;
  }
  try {
    await start(input.name, input.signal);
    const details = await inspect(input.name, input.signal);
    await waitUntilReady(details.Id, input.signal);
    await trustEgressCa(details.Id, egressCaPem);
    return toContainer(details);
  } catch (error) {
    await removeContainer(input.name).catch(() => undefined);
    throw error;
  }
}

/**
 * Return a running sandbox container. Start it again when it stopped.
 * A missing container throws a 404 `DockerApiError`.
 */
export async function getContainer(
  name: string,
  egressCaPem: string,
  signal?: AbortSignal,
): Promise<SandboxContainer> {
  let details = await inspect(name, signal);
  if (!details.State.Running) {
    await start(name, signal);
    details = await inspect(name, signal);
  }
  await waitUntilReady(details.Id, signal);
  await trustEgressCa(details.Id, egressCaPem);
  return toContainer(details);
}

/** Remove a sandbox container, its inner Docker volume, and its network. */
export async function removeContainer(name: string): Promise<void> {
  try {
    await dockerRequest({
      method: "DELETE",
      path: `/containers/${encodeURIComponent(name)}`,
      query: { force: true, v: true },
    });
  } catch (error) {
    // 409 means that Docker already removes an auto-remove container.
    if (!isStatus(error, 404) && !isStatus(error, 409)) throw error;
  }
  await removeNetwork(name);
}

/** Stop a sandbox container. A container that is not persistent goes away. */
export async function stopContainer(id: string): Promise<void> {
  try {
    await dockerRequest({
      method: "POST",
      path: `/containers/${id}/stop`,
      query: { t: 5 },
    });
  } catch (error) {
    if (!isStatus(error, 304) && !isStatus(error, 404)) throw error;
  }
}

/** Move the container's stop deadline later by `durationMs`. */
export async function extendDeadline(
  id: string,
  durationMs: number,
): Promise<void> {
  const seconds = Math.ceil(durationMs / 1000);
  const result = await runRawExec(id, {
    cmd: [
      "sh",
      "-c",
      `d=$(cat /run/junior/deadline); echo $((d + ${seconds})) > /run/junior/deadline`,
    ],
    root: true,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Could not extend sandbox timeout: ${result.stderr}`);
  }
}

/** The uid and gid of the sandbox user, for files that Junior writes. */
export const SANDBOX_FILE_OWNER = { uid: 1000, gid: 1000, user: SANDBOX_USER };
