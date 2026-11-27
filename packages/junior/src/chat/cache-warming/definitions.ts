/**
 * Detects idle periods whose system prompt or tool definitions a newer
 * deployment changed. The queue pins a warmup chain to its old deployment,
 * so each deployment publishes a fingerprint at idle start. The fingerprint
 * leaves out MCP providers that are connected or active and their tool
 * schemas: they differ per person, and providers change them, not deploys.
 */
import { createHash } from "node:crypto";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { buildDeploymentSystemPrompt } from "@/chat/system-prompt";
import {
  staticToolDefinitions,
  type ToolDefinitionsKey,
} from "@/chat/tool-support/registry";
import { getChatConfig } from "@/chat/config";
import { MINUTE_MS } from "./model";
import { KEY_PREFIX, type ConnectedState } from "./request";

/** The definitions fingerprint of an idle period and its deployment. */
export interface IdleDefinitions extends ToolDefinitionsKey {
  deploymentId: string;
  fingerprint: string;
}

/** The fingerprint that the newest deployment published for one key. */
interface PublishedFingerprint {
  deploymentId: string;
  firstSeenMs: number;
  fingerprint: string;
}

// The records outlive idle horizons, so a quiet day does not reset them.
const RECORD_TTL_MS = 7 * 24 * 60 * MINUTE_MS;

const firstSeenKey = (deploymentId: string) =>
  `${KEY_PREFIX}:defs:first_seen:${deploymentId}`;
const fingerprintKey = (key: ToolDefinitionsKey) =>
  `${KEY_PREFIX}:defs:fingerprint:${key.platform}:${key.mode}`;

// The configured MCP providers, as their plugin manifests declare them.
function configuredMcpProviders() {
  return pluginCatalogRuntime
    .getMcpProviders()
    .map(({ manifest }) => ({
      provider: manifest.name,
      displayName: manifest.displayName,
      description: manifest.description,
      allowedTools: [...(manifest.mcp?.allowedTools ?? [])].sort(),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * Hash the definitions that this deployment sets for one platform and Prompt
 * mode. It builds them on each call, because a module cache would be a
 * mutable runtime global; it runs once per idle start.
 */
export async function definitionsFingerprint(
  key: ToolDefinitionsKey,
): Promise<string> {
  const tools = Object.entries(staticToolDefinitions(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, definition]) => ({
      name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      exposure: definition.exposure,
      source: definition.source,
    }));
  return createHash("sha256")
    .update(
      JSON.stringify({
        systemPrompt: await buildDeploymentSystemPrompt(key.platform, key.mode),
        tools,
        mcpProviders: configuredMcpProviders(),
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

/**
 * Publish this deployment's fingerprint for a new idle period's key and
 * return it, or `undefined` outside Vercel. Deployments are ordered by first
 * publish; one replaces only an older record, so an old deployment's late
 * Turn cannot switch it back. Two new ones can race. Each publish refreshes
 * both TTLs, so a long-running deployment keeps its first-seen time.
 */
export async function publishDefinitions(
  state: ConnectedState,
  key: ToolDefinitionsKey,
): Promise<IdleDefinitions | undefined> {
  const deploymentId = getChatConfig().deployment.id;
  if (!deploymentId) return undefined;
  const fingerprint = await definitionsFingerprint(key);
  const nowMs = Date.now();
  let firstSeenMs = nowMs;
  if (
    !(await state.setIfNotExists(
      firstSeenKey(deploymentId),
      nowMs,
      RECORD_TTL_MS,
    ))
  ) {
    firstSeenMs =
      (await state.get<number>(firstSeenKey(deploymentId))) ?? nowMs;
    await state.set(firstSeenKey(deploymentId), firstSeenMs, RECORD_TTL_MS);
  }
  const published = await state.get<PublishedFingerprint>(fingerprintKey(key));
  if (
    !published ||
    published.deploymentId === deploymentId ||
    published.firstSeenMs < firstSeenMs
  ) {
    await state.set<PublishedFingerprint>(
      fingerprintKey(key),
      { deploymentId, firstSeenMs, fingerprint },
      RECORD_TTL_MS,
    );
  }
  return { ...key, deploymentId, fingerprint };
}

/**
 * Return whether a newer deployment published another fingerprint for the
 * key of this idle period.
 */
export async function definitionsChanged(
  state: ConnectedState,
  definitions: IdleDefinitions,
): Promise<boolean> {
  const published = await state.get<PublishedFingerprint>(
    fingerprintKey(definitions),
  );
  return (
    published !== null &&
    published.deploymentId !== definitions.deploymentId &&
    published.fingerprint !== definitions.fingerprint
  );
}
