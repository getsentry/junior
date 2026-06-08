import type {
  AgentPluginRequester,
  AgentPluginReadState,
  AgentPluginRoute,
  AgentPluginRouteMethod,
  AgentPluginSandbox,
  PluginOperationalReport,
  PluginOperationalReportContent,
  PluginOperationalTone,
  SlackConversationLink,
  JuniorPluginRegistration,
} from "@sentry/junior-plugin-api";
import { logInfo } from "@/chat/logging";
import { createAgentPluginLogger } from "@/chat/plugins/logging";
import { createPluginState } from "@/chat/plugins/state";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import type { ToolDefinition } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import type {
  SandboxCommandInput,
  SandboxInstance,
} from "@/chat/sandbox/workspace";
import { createSlackDirectCredentialSubject } from "@/chat/credentials/subject";
import { resolveChannelCapabilities } from "@/chat/tools/channel-capabilities";

/** Signal that a plugin intentionally denied a tool execution. */
export class AgentPluginHookDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentPluginHookDeniedError";
  }
}

export interface ToolHookInput {
  input: Record<string, unknown>;
  name: string;
}

export interface ToolHookResult {
  env: Record<string, string>;
  input: Record<string, unknown>;
}

export interface AgentPluginRouteRegistration extends AgentPluginRoute {
  pluginName: string;
}

export interface AgentPluginHookRunner {
  beforeToolExecute(input: ToolHookInput): Promise<ToolHookResult>;
  prepareSandbox(sandbox: SandboxInstance): Promise<void>;
}

let agentPlugins: JuniorPluginRegistration[] = [];
const AGENT_PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;
const AGENT_PLUGIN_TOOL_NAME_RE = /^[a-z][A-Za-z0-9]*$/;
const OPERATIONAL_REPORT_MAX_METRICS = 8;
const OPERATIONAL_REPORT_MAX_RECORD_SETS = 8;
const OPERATIONAL_REPORT_MAX_FIELDS = 8;
const OPERATIONAL_REPORT_MAX_RECORDS = 25;
const OPERATIONAL_REPORT_MAX_LABEL_LENGTH = 80;
const OPERATIONAL_REPORT_MAX_VALUE_LENGTH = 160;
const AGENT_PLUGIN_ROUTE_METHODS = new Set<AgentPluginRouteMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "ALL",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateLegacyStatePrefixes(plugin: JuniorPluginRegistration): void {
  const prefixes = plugin.legacyStatePrefixes;
  if (prefixes === undefined) {
    return;
  }
  if (!Array.isArray(prefixes)) {
    throw new Error(
      `Plugin "${plugin.name}" legacyStatePrefixes must be an array`,
    );
  }

  const allowedPrefix = `junior:${plugin.name}`;
  for (const rawPrefix of prefixes) {
    const prefix = typeof rawPrefix === "string" ? rawPrefix.trim() : "";
    if (!prefix) {
      throw new Error(
        `Plugin "${plugin.name}" legacy state prefixes must be non-empty strings`,
      );
    }
    if (prefix !== allowedPrefix && !prefix.startsWith(`${allowedPrefix}:`)) {
      throw new Error(
        `Plugin "${plugin.name}" legacy state prefix "${prefix}" must stay under "${allowedPrefix}"`,
      );
    }
  }
}

/** Validate plugin identity before it can affect process-wide hooks. */
export function validateAgentPlugins(
  plugins: JuniorPluginRegistration[],
): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (!AGENT_PLUGIN_NAME_RE.test(plugin.name)) {
      throw new Error(
        `Plugin name "${plugin.name}" must be a lowercase plugin identifier`,
      );
    }
    if (seen.has(plugin.name)) {
      throw new Error(`Duplicate plugin name "${plugin.name}"`);
    }
    seen.add(plugin.name);
    validateLegacyStatePrefixes(plugin);
  }
}

/** Replace runtime hook plugins and return the previous list for rollback. */
export function setAgentPlugins(
  plugins: JuniorPluginRegistration[],
): JuniorPluginRegistration[] {
  validateAgentPlugins(plugins);
  const previous = agentPlugins;
  agentPlugins = [...plugins].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  return previous;
}

/** Return the current runtime hook plugins without exposing mutable state. */
export function getAgentPlugins(): JuniorPluginRegistration[] {
  return [...agentPlugins];
}

/** Collect turn-scoped tools exposed by plugins. */
export function getAgentPluginTools(
  context: ToolRuntimeContext,
): Record<string, ToolDefinition<any>> {
  const tools: Record<string, ToolDefinition<any>> = {};
  for (const plugin of getAgentPlugins()) {
    const hook = plugin.hooks?.tools;
    if (!hook) {
      continue;
    }
    const log = createAgentPluginLogger(plugin.name);
    // Plugins receive the raw Slack conversation channel. The dispatch
    // destination is the provider-neutral address for autonomous work.
    const destination = context.destination;
    const credentialSubject = createSlackDirectCredentialSubject({
      channelId: context.channelId,
      teamId: context.teamId,
      userId: context.requester?.userId,
    });
    const pluginCapabilities = resolveChannelCapabilities(context.channelId);
    const pluginTools = hook({
      plugin: { name: plugin.name },
      log,
      requester: context.requester,
      channelCapabilities: pluginCapabilities,
      channelId: context.channelId,
      conversationId: context.conversationId,
      ...(credentialSubject ? { credentialSubject } : {}),
      ...(destination ? { destination } : {}),
      teamId: context.teamId,
      messageTs: context.messageTs,
      threadTs: context.threadTs,
      userText: context.userText,
      state: createPluginState(plugin.name, {
        legacyStatePrefixes: plugin.legacyStatePrefixes,
      }),
    });
    for (const [name, tool] of Object.entries(pluginTools)) {
      if (!AGENT_PLUGIN_TOOL_NAME_RE.test(name)) {
        throw new Error(
          `Plugin tool "${name}" from plugin "${plugin.name}" must be a camelCase identifier`,
        );
      }
      if (tools[name]) {
        throw new Error(
          `Duplicate plugin tool "${name}" from plugin "${plugin.name}"`,
        );
      }
      tools[name] = tool as unknown as ToolDefinition<any>;
    }
  }
  return tools;
}

/** Normalize route methods so JS plugins cannot register invalid verbs. */
function routeMethods(
  route: AgentPluginRoute,
  pluginName: string,
): AgentPluginRouteMethod[] {
  const methods = Array.isArray(route.method)
    ? route.method
    : [route.method ?? "ALL"];
  if (methods.length === 0) {
    throw new Error(
      `Plugin route "${route.path}" from plugin "${pluginName}" must declare at least one method`,
    );
  }

  for (const method of methods) {
    if (!AGENT_PLUGIN_ROUTE_METHODS.has(method)) {
      throw new Error(
        `Plugin route "${route.path}" from plugin "${pluginName}" has invalid method "${String(method)}"`,
      );
    }
  }
  if (methods.includes("ALL") && methods.length > 1) {
    throw new Error(
      `Plugin route "${route.path}" from plugin "${pluginName}" must not combine ALL with explicit methods`,
    );
  }
  return methods;
}

/** Collect route handlers exposed by plugins for app-level mounting. */
export function getAgentPluginRoutes(): AgentPluginRouteRegistration[] {
  const routes: AgentPluginRouteRegistration[] = [];
  const seen = new Set<string>();
  const methodsByPath = new Map<string, Set<AgentPluginRouteMethod>>();

  for (const plugin of getAgentPlugins()) {
    const hook = plugin.hooks?.routes;
    if (!hook) {
      continue;
    }
    const log = createAgentPluginLogger(plugin.name);
    const pluginRoutes = hook({
      plugin: { name: plugin.name },
      log,
    });
    if (!Array.isArray(pluginRoutes)) {
      throw new Error(
        `Plugin routes hook from plugin "${plugin.name}" must return an array`,
      );
    }
    for (const route of pluginRoutes) {
      if (!isRecord(route)) {
        throw new Error(
          `Plugin route from plugin "${plugin.name}" must be an object`,
        );
      }
      if (typeof route.path !== "string" || !route.path.startsWith("/")) {
        throw new Error(
          `Plugin route "${route.path}" from plugin "${plugin.name}" must start with /`,
        );
      }
      if (typeof route.handler !== "function") {
        throw new Error(
          `Plugin route "${route.path}" from plugin "${plugin.name}" must provide a handler`,
        );
      }
      const methods = routeMethods(route, plugin.name);
      const pathMethods = methodsByPath.get(route.path) ?? new Set();
      if (
        pathMethods.has("ALL") ||
        (methods.includes("ALL") && pathMethods.size > 0)
      ) {
        throw new Error(
          `Plugin route "${route.path}" conflicts with an ALL route for the same path`,
        );
      }
      for (const method of methods) {
        const key = `${method}:${route.path}`;
        if (seen.has(key)) {
          throw new Error(`Duplicate plugin route "${method} ${route.path}"`);
        }
        seen.add(key);
        pathMethods.add(method);
      }
      methodsByPath.set(route.path, pathMethods);
      routes.push({
        ...route,
        pluginName: plugin.name,
      });
    }
  }

  return routes;
}

/** Return only absolute HTTP(S) URLs that Slack can render as footer links. */
function trustedSlackConversationUrl(
  pluginName: string,
  link: SlackConversationLink | undefined,
): string | undefined {
  const url = typeof link?.url === "string" ? link.url.trim() : "";
  if (!url) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error(
      `Plugin "${pluginName}" slackConversationLink must return an absolute http(s) URL`,
      { cause: error },
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Plugin "${pluginName}" slackConversationLink must return an absolute http(s) URL`,
    );
  }
  return parsed.toString();
}

/** Resolve the first plugin conversation URL for finalized Slack footers. */
export function getAgentPluginSlackConversationLink(
  conversationId: string,
): SlackConversationLink | undefined {
  for (const plugin of getAgentPlugins()) {
    const hook = plugin.hooks?.slackConversationLink;
    if (!hook) {
      continue;
    }
    const log = createAgentPluginLogger(plugin.name);
    const link = hook({
      plugin: { name: plugin.name },
      log,
      conversationId,
    });
    const url = trustedSlackConversationUrl(plugin.name, link);
    if (url) {
      return { url };
    }
  }
  return undefined;
}

function pluginReadState(state: { get: AgentPluginReadState["get"] }) {
  return {
    get: state.get,
  } satisfies AgentPluginReadState;
}

function operationalReportText(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length <= maxLength
    ? trimmed
    : `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
}

function operationalReportTone(
  tone: PluginOperationalTone | undefined,
): PluginOperationalTone | undefined {
  return tone === "danger" ||
    tone === "good" ||
    tone === "neutral" ||
    tone === "warning"
    ? tone
    : undefined;
}

function sanitizeOperationalReport(args: {
  pluginName: string;
  report: PluginOperationalReportContent;
}): PluginOperationalReport {
  const metrics = args.report.metrics
    ?.slice(0, OPERATIONAL_REPORT_MAX_METRICS)
    .map((metric) => {
      const label = operationalReportText(
        metric.label,
        OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
      );
      const value = operationalReportText(
        metric.value,
        OPERATIONAL_REPORT_MAX_VALUE_LENGTH,
      );
      if (!label || !value) {
        return undefined;
      }
      const sanitizedMetric: NonNullable<
        PluginOperationalReport["metrics"]
      >[number] = { label, value };
      const tone = operationalReportTone(metric.tone);
      if (tone) {
        sanitizedMetric.tone = tone;
      }
      return sanitizedMetric;
    })
    .filter((metric): metric is NonNullable<typeof metric> => Boolean(metric));
  const recordSets = args.report.recordSets
    ?.slice(0, OPERATIONAL_REPORT_MAX_RECORD_SETS)
    .map((recordSet, recordSetIndex) => {
      const title = operationalReportText(
        recordSet.title,
        OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
      );
      if (!title) {
        return undefined;
      }
      const fields = recordSet.fields
        ?.slice(0, OPERATIONAL_REPORT_MAX_FIELDS)
        .map((field) => {
          const key = operationalReportText(
            field.key,
            OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
          );
          const label = operationalReportText(
            field.label,
            OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
          );
          return key && label ? { key, label } : undefined;
        })
        .filter((field): field is NonNullable<typeof field> => Boolean(field));
      const records = recordSet.records
        ?.slice(0, OPERATIONAL_REPORT_MAX_RECORDS)
        .map((record, recordIndex) => {
          const id =
            operationalReportText(
              record.id,
              OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
            ) ?? `${recordSetIndex}:${recordIndex}`;
          const values = Object.fromEntries(
            (fields ?? []).map((field) => [
              field.key,
              operationalReportText(
                record.values[field.key],
                OPERATIONAL_REPORT_MAX_VALUE_LENGTH,
              ) ?? "",
            ]),
          );
          const sanitizedRecord: NonNullable<
            NonNullable<
              PluginOperationalReport["recordSets"]
            >[number]["records"]
          >[number] = {
            id,
            values,
          };
          const tone = operationalReportTone(record.tone);
          if (tone) {
            sanitizedRecord.tone = tone;
          }
          return sanitizedRecord;
        });
      const sanitizedRecordSet: NonNullable<
        PluginOperationalReport["recordSets"]
      >[number] = { title };
      if (fields?.length) {
        sanitizedRecordSet.fields = fields;
      }
      const emptyText = operationalReportText(
        recordSet.emptyText,
        OPERATIONAL_REPORT_MAX_VALUE_LENGTH,
      );
      if (emptyText) {
        sanitizedRecordSet.emptyText = emptyText;
      }
      if (records?.length) {
        sanitizedRecordSet.records = records;
      }
      return sanitizedRecordSet;
    })
    .filter((recordSet): recordSet is NonNullable<typeof recordSet> =>
      Boolean(recordSet),
    );

  const sanitized: PluginOperationalReport = {
    pluginName: args.pluginName,
  };
  const generatedAt = operationalReportText(
    args.report.generatedAt,
    OPERATIONAL_REPORT_MAX_VALUE_LENGTH,
  );
  if (generatedAt) {
    sanitized.generatedAt = generatedAt;
  }
  if (recordSets?.length) {
    sanitized.recordSets = recordSets;
  }
  if (metrics?.length) {
    sanitized.metrics = metrics;
  }
  const title = operationalReportText(
    args.report.title,
    OPERATIONAL_REPORT_MAX_LABEL_LENGTH,
  );
  if (title) {
    sanitized.title = title;
  }
  return sanitized;
}

function failedOperationalReport(args: {
  nowMs: number;
  pluginName: string;
}): PluginOperationalReport {
  return {
    generatedAt: new Date(args.nowMs).toISOString(),
    pluginName: args.pluginName,
    metrics: [{ label: "report", tone: "danger", value: "failed" }],
    title: args.pluginName,
    recordSets: [
      {
        emptyText: "This plugin report failed to load.",
        title: "Error",
      },
    ],
  };
}

/** Collect read-only operational summaries exposed by plugins. */
export async function getAgentPluginOperationalReports(
  nowMs = Date.now(),
): Promise<PluginOperationalReport[]> {
  const reports: PluginOperationalReport[] = [];
  for (const plugin of getAgentPlugins()) {
    const hook = plugin.hooks?.operationalReport;
    if (!hook) {
      continue;
    }
    const log = createAgentPluginLogger(plugin.name);
    try {
      const state = createPluginState(plugin.name, {
        legacyStatePrefixes: plugin.legacyStatePrefixes,
      });
      const report = await hook({
        plugin: { name: plugin.name },
        log,
        nowMs,
        state: pluginReadState(state),
      });
      if (!report) {
        continue;
      }
      reports.push(
        sanitizeOperationalReport({
          pluginName: plugin.name,
          report,
        }),
      );
    } catch (error) {
      log.error("Plugin operational report failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      reports.push(failedOperationalReport({ nowMs, pluginName: plugin.name }));
    }
  }
  return reports;
}

function normalizeEnv(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue === "string") {
      env[key] = rawValue;
    }
  }
  return env;
}

function createSandboxCapability(sandbox: SandboxInstance): AgentPluginSandbox {
  return {
    root: SANDBOX_WORKSPACE_ROOT,
    juniorRoot: `${SANDBOX_WORKSPACE_ROOT}/.junior`,
    async readFile(filePath) {
      return (await sandbox.readFileToBuffer({ path: filePath })) ?? null;
    },
    async run(input: SandboxCommandInput) {
      const result = await sandbox.runCommand(input);
      const [stdout, stderr] = await Promise.all([
        result.stdout(),
        result.stderr(),
      ]);
      return {
        exitCode: result.exitCode,
        stdout,
        stderr,
      };
    },
    async writeFile(input) {
      await sandbox.writeFiles([
        {
          path: input.path,
          content: input.content,
          ...(input.mode !== undefined ? { mode: input.mode } : {}),
        },
      ]);
    },
  };
}

/** Create one runner over runtime hook plugins registered by the app. */
export function createAgentPluginHookRunner(
  input: {
    requester?: AgentPluginRequester;
  } = {},
): AgentPluginHookRunner {
  const loaded = getAgentPlugins();

  return {
    async prepareSandbox(sandbox) {
      const sandboxCapability = createSandboxCapability(sandbox);
      for (const plugin of loaded) {
        const hook = plugin.hooks?.sandboxPrepare;
        if (!hook) {
          continue;
        }
        logInfo(
          "agent_plugin_hook_sandbox_prepare",
          {},
          { "app.plugin.name": plugin.name },
          "Running agent plugin sandbox prepare hook",
        );
        await hook({
          plugin: { name: plugin.name },
          log: createAgentPluginLogger(plugin.name),
          requester: input.requester,
          sandbox: sandboxCapability,
        });
      }
    },
    async beforeToolExecute(tool) {
      let nextInput = { ...tool.input };
      const env = normalizeEnv(nextInput.env);

      for (const plugin of loaded) {
        const hook = plugin.hooks?.beforeToolExecute;
        if (!hook) {
          continue;
        }
        let replacement: Record<string, unknown> | undefined;
        let denied: string | undefined;
        await hook({
          plugin: { name: plugin.name },
          log: createAgentPluginLogger(plugin.name),
          requester: input.requester,
          tool: {
            name: tool.name,
            input: nextInput,
          },
          env: {
            get(key) {
              return env[key];
            },
            set(key, value) {
              env[key] = value;
            },
          },
          decision: {
            deny(message) {
              denied = message;
            },
            replaceInput(input) {
              replacement = input;
            },
          },
        });

        if (denied) {
          throw new AgentPluginHookDeniedError(denied);
        }
        if (replacement !== undefined) {
          if (!isRecord(replacement)) {
            throw new Error(
              `Plugin "${plugin.name}" replaced tool input with a non-object value`,
            );
          }
          nextInput = { ...replacement };
          Object.assign(env, normalizeEnv(nextInput.env));
        }
      }

      return {
        input: {
          ...nextInput,
          ...(Object.keys(env).length > 0 ? { env } : {}),
        },
        env,
      };
    },
  };
}
