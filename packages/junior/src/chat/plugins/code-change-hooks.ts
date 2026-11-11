/**
 * Read code changes through the plugin that owns their provider.
 *
 * Core never calls a provider API. Host features such as Walkthroughs ask the
 * plugin named by the code change's provider, and check what comes back.
 */
import {
  codeChangeDiffSchema,
  codeChangeStackSchema,
  type CodeChangeDiff,
  type CodeChangeHooks,
  type CodeChangeStack,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import { credentialContextForActor } from "@/chat/credentials/context";
import { createPluginEgress } from "@/chat/egress/plugin";
import { getPlugins } from "@/chat/plugins/agent-hooks";
import { basePluginContext } from "@/chat/plugins/hook-context";

// These reads run outside a Turn, so they have no requester credentials.
// They use this system Actor, never a user's credentials.
const CODE_CHANGE_READ_SYSTEM_ACTOR = {
  platform: "system",
  name: "code-change-read",
} as const;

/** Whether a plugin can read the code changes of this provider. */
export function canReadCodeChanges(provider: string): boolean {
  return Boolean(pluginFor(provider)?.hooks?.codeChanges);
}

/** Read the stack that contains one code change, bottom first. */
export async function readPluginCodeChangeStack(input: {
  provider: string;
  repository: string;
  number: number;
  signal: AbortSignal;
}): Promise<CodeChangeStack | undefined> {
  const { plugin, hooks } = codeChangeHooks(input.provider);
  const stack = await hooks.readStack({
    ...readContext(plugin, input.signal),
    repository: input.repository,
    number: input.number,
  });
  return stack === undefined
    ? undefined
    : parseSchema(
        codeChangeStackSchema,
        stack,
        `Plugin "${plugin.manifest.name}" readStack returned an invalid stack`,
      );
}

/** Read the files changed between two commits. */
export async function readPluginCodeChangeDiff(input: {
  provider: string;
  repository: string;
  baseSha: string;
  headSha: string;
  signal: AbortSignal;
}): Promise<CodeChangeDiff> {
  const { plugin, hooks } = codeChangeHooks(input.provider);
  return parseSchema(
    codeChangeDiffSchema,
    await hooks.readDiff({
      ...readContext(plugin, input.signal),
      repository: input.repository,
      baseSha: input.baseSha,
      headSha: input.headSha,
    }),
    `Plugin "${plugin.manifest.name}" readDiff returned an invalid diff`,
  );
}

/** Read one file's text at a commit. */
export async function readPluginCodeFile(input: {
  provider: string;
  repository: string;
  sha: string;
  path: string;
  signal: AbortSignal;
}): Promise<string | undefined> {
  const { plugin, hooks } = codeChangeHooks(input.provider);
  const text = await hooks.readFile({
    ...readContext(plugin, input.signal),
    repository: input.repository,
    sha: input.sha,
    path: input.path,
  });
  if (text !== undefined && typeof text !== "string") {
    throw new Error(
      `Plugin "${plugin.manifest.name}" readFile returned a non-string`,
    );
  }
  return text;
}

/**
 * The provider's link to one line at a commit, or `undefined` when the
 * plugin has no line links or returns something that is not a URL.
 */
export function codeLineUrl(input: {
  provider: string;
  repository: string;
  sha: string;
  path: string;
  line: number;
}): string | undefined {
  const { provider, ...line } = input;
  const url = codeChangeHooks(provider).hooks.lineUrl?.(line);
  return url !== undefined && URL.canParse(url) ? url : undefined;
}

function parseSchema<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  value: unknown,
  message: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(message);
  return result.data;
}

function pluginFor(provider: string): PluginRegistration | undefined {
  return getPlugins().find((plugin) => plugin.manifest.name === provider);
}

function codeChangeHooks(provider: string): {
  plugin: PluginRegistration;
  hooks: CodeChangeHooks;
} {
  const plugin = pluginFor(provider);
  const hooks = plugin?.hooks?.codeChanges;
  if (!plugin || !hooks) {
    throw new Error(`Provider "${provider}" cannot read code changes`);
  }
  return { plugin, hooks };
}

function readContext(plugin: PluginRegistration, signal: AbortSignal) {
  return {
    ...basePluginContext(plugin),
    egress: createPluginEgress({
      credentialContext: credentialContextForActor(
        CODE_CHANGE_READ_SYSTEM_ACTOR,
      ),
      // Host reads must never ask anyone to authorize.
      pluginAuth: { async handleAuthRequired() {} },
    }),
    signal,
  };
}
