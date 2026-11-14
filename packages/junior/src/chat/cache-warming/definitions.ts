/**
 * Detects idle periods whose definitions a newer deployment changed.
 *
 * The definitions of a request are its system prompt and tool definitions:
 * the start of the cached prefix that a deploy can change. The queue pins
 * each warmup to the deployment that sent it, so a warmup chain keeps running
 * on the old deployment after a deploy. That deployment builds the old
 * definitions, so the warmup cannot see a change by itself. So each
 * deployment publishes a fingerprint of its definitions when it starts an
 * idle period, and an old deployment's idle period with another fingerprint
 * stops.
 *
 * The fingerprint holds only what the deployment sets: the system prompt,
 * the static tool definitions (`staticToolDefinitions`), and the configured
 * MCP providers. It leaves out the connected and active MCP providers and
 * the MCP tool schemas that the providers return. They differ per
 * Conversation and person, a new deployment cannot publish them for
 * Conversations that have not come back, and the providers change them, not
 * our deploys. So a change to only these parts, or to the run-built tools,
 * does not stop an old idle period.
 */
import { createHash } from "node:crypto";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { buildDeploymentSystemPrompt } from "@/chat/system-prompt";
import {
  staticToolDefinitions,
  type ToolDefinitionsKey,
} from "@/chat/tools/registry";
import { getDeploymentId } from "@/deployment";
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
 * Publish this deployment's fingerprint for the key of a new idle period,
 * and return the fingerprint to store on it. Returns `undefined` outside
 * Vercel, where there is no deployment to compare.
 *
 * Neither the queue nor Vercel gives an order of deployments, so the order is
 * the time each deployment first published. A deployment only replaces a
 * record of a deployment that it was first seen after, so a late Turn of an
 * old deployment during a rollout cannot switch it back. Two new deployments
 * that start at the same time can race; the last write wins.
 */
export async function publishDefinitions(
  state: ConnectedState,
  key: ToolDefinitionsKey,
): Promise<IdleDefinitions | undefined> {
  const deploymentId = getDeploymentId();
  if (!deploymentId) return undefined;
  const fingerprint = await definitionsFingerprint(key);
  const nowMs = Date.now();
  const firstSeenMs = (await state.setIfNotExists(
    firstSeenKey(deploymentId),
    nowMs,
    RECORD_TTL_MS,
  ))
    ? nowMs
    : ((await state.get<number>(firstSeenKey(deploymentId))) ?? nowMs);
  const published = await state.get<PublishedFingerprint>(fingerprintKey(key));
  if (
    !published ||
    (published.deploymentId !== deploymentId &&
      published.firstSeenMs < firstSeenMs)
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
