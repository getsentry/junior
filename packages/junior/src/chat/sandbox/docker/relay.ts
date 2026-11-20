import {
  DockerApiError,
  dockerJson,
  dockerRequest,
} from "@/chat/sandbox/docker/api";
import {
  createLeafKey,
  issueLeafCertificate,
  type EgressCa,
} from "@/chat/sandbox/docker/certificates";
import {
  egressRelayName,
  type SandboxContainer,
} from "@/chat/sandbox/docker/container";
import { ensureRuntimeImage } from "@/chat/sandbox/docker/runtime-image";
import { DOCKER_SANDBOX_LABEL } from "@/chat/sandbox/docker/settings";
import { packTar } from "@/chat/sandbox/docker/tar";
import { SANDBOX_RUNTIME } from "@/chat/sandbox/snapshot/runtime";

// Module overview: the egress relay for Docker daemons in a VM.
//
// On Docker Desktop and OrbStack, the daemon runs in a Linux VM. A sandbox
// cannot reach a proxy on the host through its network gateway. Through
// `host.docker.internal`, the host sees every connection come from one VM
// address. So the proxy cannot tell sandboxes apart by source address.
//
// A relay container joins the sandbox's own network. Only that sandbox can
// reach it. The relay sends each connection to the proxy over TLS with a
// client certificate for the sandbox's container id. The egress CA signs that
// certificate, and the key stays in the relay container. The proxy accepts
// only connections with a valid client certificate, so a sandbox cannot use
// another sandbox's identity.

/** Host name of the Docker host as seen from a container. */
export const RELAY_PROXY_HOST = "host.docker.internal";
const RELAY_PORT = 15080;
const RELAY_DIR = "/run/junior-relay";
/** Label with the proxy port that the relay sends to. */
const TARGET_LABEL = "dev.junior.sandbox.relay-target";

interface RelayInspect {
  Id: string;
  State: { Running: boolean };
  Config: { Labels: Record<string, string> };
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
}

/**
 * Return whether sandboxes reach the proxy through a relay.
 *
 * On Linux, the Docker daemon runs on this host, and the sandbox network
 * gateway is a host address. Other systems run the daemon in a VM.
 */
export function usesEgressRelay(): boolean {
  return process.platform !== "linux";
}

async function inspectRelay(name: string): Promise<RelayInspect | undefined> {
  try {
    return await dockerJson<RelayInspect>({
      path: `/containers/${encodeURIComponent(name)}/json`,
    });
  } catch (error) {
    if (error instanceof DockerApiError && error.statusCode === 404) {
      return undefined;
    }
    throw error;
  }
}

function relayAddress(container: SandboxContainer, relay: RelayInspect) {
  const ip = relay.NetworkSettings.Networks[container.name]?.IPAddress;
  if (!ip) throw new Error(`Egress relay of ${container.name} has no address`);
  return `${ip}:${RELAY_PORT}`;
}

function relayFiles(ca: EgressCa, container: SandboxContainer): Buffer {
  const key = createLeafKey();
  const files = {
    "client.pem": issueLeafCertificate(ca, container.id, key),
    "client-key.pem": key.export({ type: "pkcs8", format: "pem" }).toString(),
    "ca.pem": ca.certPem,
  };
  return packTar(
    Object.entries(files).map(([file, content]) => ({
      path: `${RELAY_DIR.slice(1)}/${file}`,
      content: Buffer.from(content),
      mode: 0o600,
      uid: 0,
      gid: 0,
    })),
  );
}

/**
 * Start the egress relay of one sandbox, or reuse it, and return the address
 * that the sandbox's redirect rules send traffic to.
 *
 * A relay sends to one proxy port. When another process applies the policy,
 * this replaces the relay so that it sends to that process's proxy.
 */
export async function ensureEgressRelay(
  container: SandboxContainer,
  ca: EgressCa,
  proxyPort: number,
): Promise<string> {
  const name = egressRelayName(container.name);
  const existing = await inspectRelay(name);
  if (
    existing?.State.Running &&
    existing.Config.Labels[TARGET_LABEL] === String(proxyPort)
  ) {
    return relayAddress(container, existing);
  }
  if (existing) {
    await dockerRequest({
      method: "DELETE",
      path: `/containers/${existing.Id}`,
      query: { force: true },
    });
  }
  const created = await dockerJson<{ Id: string }>({
    method: "POST",
    path: "/containers/create",
    query: { name },
    body: {
      Image: await ensureRuntimeImage(SANDBOX_RUNTIME),
      Cmd: [
        "socat",
        `TCP-LISTEN:${RELAY_PORT},fork,reuseaddr`,
        `OPENSSL:${RELAY_PROXY_HOST}:${proxyPort},cert=${RELAY_DIR}/client.pem,key=${RELAY_DIR}/client-key.pem,cafile=${RELAY_DIR}/ca.pem`,
      ],
      User: "root",
      // The network prune removes a relay whose sandbox is gone.
      Labels: {
        [DOCKER_SANDBOX_LABEL]: `relay:${container.name}`,
        [TARGET_LABEL]: String(proxyPort),
      },
      HostConfig: {
        NetworkMode: container.name,
        ExtraHosts: [`${RELAY_PROXY_HOST}:host-gateway`],
      },
    },
  });
  await dockerRequest({
    method: "PUT",
    path: `/containers/${created.Id}/archive`,
    query: { path: "/" },
    body: relayFiles(ca, container),
  });
  await dockerRequest({
    method: "POST",
    path: `/containers/${created.Id}/start`,
  });
  const started = await inspectRelay(created.Id);
  if (!started?.State.Running) {
    throw new Error(`Egress relay of ${container.name} did not start`);
  }
  return relayAddress(container, started);
}
