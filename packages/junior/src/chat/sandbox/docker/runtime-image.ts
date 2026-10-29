import { createHash, randomUUID } from "node:crypto";
import {
  DockerApiError,
  dockerJson,
  dockerOkStream,
  dockerRequest,
  readStream,
} from "@/chat/sandbox/docker/api";
import {
  COMMAND_STATE_DIR,
  runRawExec,
  SANDBOX_USER,
} from "@/chat/sandbox/docker/exec";
import { DOCKER_SANDBOX_LABEL } from "@/chat/sandbox/docker/settings";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";

// Module overview: build the local image that stands in for a Vercel Sandbox
// runtime. It matches the parts of Vercel's `node22` image that Junior uses:
// Amazon Linux 2023, Node 22, `dnf`, passwordless `sudo`, the
// `vercel-sandbox` user, and the workspace directory.

const BASE_IMAGE = { name: "amazonlinux", tag: "2023" };
const RUNTIME_REPOSITORY = "junior-sandbox-runtime";
/** System packages for each runtime, installed on top of the base image. */
const RUNTIME_PACKAGES: Record<string, string[]> = {
  node22: ["nodejs22", "nodejs22-npm"],
};
const COMMON_PACKAGES = [
  "coreutils",
  "diffutils",
  "findutils",
  "git",
  "gzip",
  "iptables-nft",
  "openssl",
  "procps-ng",
  "shadow-utils",
  // The egress relay runs `socat`. See `relay.ts`.
  "socat",
  "sudo",
  "tar",
  "unzip",
  "util-linux",
  "which",
];

function buildScript(runtime: string): string {
  const packages = RUNTIME_PACKAGES[runtime];
  if (!packages) {
    throw new Error(`The Docker sandbox provider has no runtime ${runtime}`);
  }
  return [
    "set -eu",
    `dnf install -y --allowerasing ${[...packages, ...COMMON_PACKAGES].join(" ")}`,
    "dnf clean all",
    `useradd --create-home --uid 1000 ${SANDBOX_USER}`,
    `echo '${SANDBOX_USER} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/${SANDBOX_USER}`,
    `chmod 0440 /etc/sudoers.d/${SANDBOX_USER}`,
    `mkdir -p ${SANDBOX_WORKSPACE_ROOT}`,
    `chown ${SANDBOX_USER}:${SANDBOX_USER} ${SANDBOX_WORKSPACE_ROOT}`,
    `mkdir -p -m 1777 ${COMMAND_STATE_DIR}`,
  ].join("\n");
}

function runtimeTag(runtime: string): string {
  const hash = createHash("sha256")
    .update(`${BASE_IMAGE.name}:${BASE_IMAGE.tag}\n${buildScript(runtime)}`)
    .digest("hex")
    .slice(0, 12);
  return `${runtime}-${hash}`;
}

async function imageExists(reference: string): Promise<boolean> {
  try {
    await dockerRequest({
      path: `/images/${encodeURIComponent(reference)}/json`,
    });
    return true;
  } catch (error) {
    if (error instanceof DockerApiError && error.statusCode === 404) {
      return false;
    }
    throw error;
  }
}

async function pullBaseImage(signal?: AbortSignal): Promise<void> {
  const stream = await dockerOkStream({
    method: "POST",
    path: "/images/create",
    query: { fromImage: BASE_IMAGE.name, tag: BASE_IMAGE.tag },
    signal,
  });
  // Pull errors arrive as JSON lines in a 200 response.
  const lines = (await readStream(stream)).toString("utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as { error?: string };
    if (event.error) throw new Error(`Docker pull failed: ${event.error}`);
  }
}

/**
 * Return the local image for a sandbox runtime. Build it on first use.
 *
 * The tag holds a hash of the build script, so a changed script builds a new
 * image. Two processes may build the same image at once. The last commit wins,
 * and both images work.
 */
export async function ensureRuntimeImage(
  runtime: string,
  signal?: AbortSignal,
): Promise<string> {
  const reference = `${RUNTIME_REPOSITORY}:${runtimeTag(runtime)}`;
  if (await imageExists(reference)) return reference;

  const base = `${BASE_IMAGE.name}:${BASE_IMAGE.tag}`;
  if (!(await imageExists(base))) await pullBaseImage(signal);
  const name = `junior-runtime-build-${randomUUID()}`;
  const created = await dockerJson<{ Id: string }>({
    method: "POST",
    path: "/containers/create",
    query: { name },
    body: {
      Image: base,
      Cmd: ["sleep", "infinity"],
      Labels: { [DOCKER_SANDBOX_LABEL]: name },
    },
    signal,
  });
  try {
    await dockerRequest({
      method: "POST",
      path: `/containers/${created.Id}/start`,
      signal,
    });
    const result = await runRawExec(
      created.Id,
      { cmd: ["sh", "-c", buildScript(runtime)], root: true },
      signal,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Docker sandbox runtime ${runtime} build failed (exit ${result.exitCode}): ${result.stderr.slice(-2000)}`,
      );
    }
    const [repo, tag] = reference.split(":");
    await dockerRequest({
      method: "POST",
      path: "/commit",
      query: {
        container: created.Id,
        repo,
        tag,
        changes: `LABEL ${DOCKER_SANDBOX_LABEL}=runtime`,
      },
      signal,
    });
    return reference;
  } finally {
    await dockerRequest({
      method: "DELETE",
      path: `/containers/${created.Id}`,
      query: { force: true, v: true },
    }).catch(() => {
      // Best-effort cleanup of the build container.
    });
  }
}
