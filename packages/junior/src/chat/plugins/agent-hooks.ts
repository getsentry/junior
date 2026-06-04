import type {
  AgentPluginRequester,
  AgentPluginReadState,
  AgentPluginRoute,
  AgentPluginRouteMethod,
  AgentPluginSandbox,
  DashboardPluginReport,
  DashboardPluginReportContent,
  DashboardPluginMetricTone,
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

/** Signal that a trusted plugin intentionally denied a tool execution. */
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
const DASHBOARD_REPORT_MAX_SUMMARY_ITEMS = 8;
const DASHBOARD_REPORT_MAX_SECTIONS = 8;
const DASHBOARD_REPORT_MAX_COLUMNS = 8;
const DASHBOARD_REPORT_MAX_ROWS = 25;
const DASHBOARD_REPORT_MAX_LABEL_LENGTH = 80;
const DASHBOARD_REPORT_MAX_VALUE_LENGTH = 160;
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

function validateLegacyStatePrefixes(plugin: JuniorPluginRegistration): void {
  const prefixes = plugin.legacyStatePrefixes;
  if (prefixes === undefined) {
    return;
  }
  if (!Array.isArray(prefixes)) {
    throw new Error(
      `Trusted plugin "${plugin.name}" legacyStatePrefixes must be an array`,
    );
  }

  const allowedPrefix = `junior:${plugin.name}`;
  for (const rawPrefix of prefixes) {
    const prefix = typeof rawPrefix === "string" ? rawPrefix.trim() : "";
    if (!prefix) {
      throw new Error(
        `Trusted plugin "${plugin.name}" legacy state prefixes must be non-empty strings`,
      );
    }
    if (prefix !== allowedPrefix && !prefix.startsWith(`${allowedPrefix}:`)) {
      throw new Error(
        `Trusted plugin "${plugin.name}" legacy state prefix "${prefix}" must stay under "${allowedPrefix}"`,
      );
    }
  }
}

/** Validate trusted plugin identity before it can affect process-wide hooks. */
export function validateAgentPlugins(
  plugins: JuniorPluginRegistration[],
): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (!AGENT_PLUGIN_NAME_RE.test(plugin.name)) {
      throw new Error(
        `Trusted plugin name "${plugin.name}" must be a lowercase plugin identifier`,
      );
    }
    if (seen.has(plugin.name)) {
      throw new Error(`Duplicate trusted plugin name "${plugin.name}"`);
    }
    seen.add(plugin.name);
    validateLegacyStatePrefixes(plugin);
  }
}

/** Replace trusted agent plugins and return the previous list for rollback. */
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

/** Return the current trusted agent plugins without exposing mutable state. */
export function getAgentPlugins(): JuniorPluginRegistration[] {
  return [...agentPlugins];
}

/** Collect turn-scoped tools exposed by trusted plugins. */
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
    const credentialSubject = createSlackDirectCredentialSubject({
      channelId: context.channelId,
      teamId: context.teamId,
      userId: context.requester?.userId,
    });
    const pluginTools = hook({
      plugin: { name: plugin.name },
      log,
      requester: context.requester,
      channelCapabilities: context.channelCapabilities,
      channelId: context.channelId,
      ...(credentialSubject ? { credentialSubject } : {}),
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
          `Trusted plugin tool "${name}" from plugin "${plugin.name}" must be a camelCase identifier`,
        );
      }
      if (tools[name]) {
        throw new Error(
          `Duplicate trusted plugin tool "${name}" from plugin "${plugin.name}"`,
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
      `Trusted plugin route "${route.path}" from plugin "${pluginName}" must declare at least one method`,
    );
  }

  for (const method of methods) {
    if (!AGENT_PLUGIN_ROUTE_METHODS.has(method)) {
      throw new Error(
        `Trusted plugin route "${route.path}" from plugin "${pluginName}" has invalid method "${String(method)}"`,
      );
    }
  }
  if (methods.includes("ALL") && methods.length > 1) {
    throw new Error(
      `Trusted plugin route "${route.path}" from plugin "${pluginName}" must not combine ALL with explicit methods`,
    );
  }
  return methods;
}

/** Collect route handlers exposed by trusted plugins for app-level mounting. */
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
        `Trusted plugin routes hook from plugin "${plugin.name}" must return an array`,
      );
    }
    for (const route of pluginRoutes) {
      if (!isRecord(route)) {
        throw new Error(
          `Trusted plugin route from plugin "${plugin.name}" must be an object`,
        );
      }
      if (typeof route.path !== "string" || !route.path.startsWith("/")) {
        throw new Error(
          `Trusted plugin route "${route.path}" from plugin "${plugin.name}" must start with /`,
        );
      }
      if (typeof route.handler !== "function") {
        throw new Error(
          `Trusted plugin route "${route.path}" from plugin "${plugin.name}" must provide a handler`,
        );
      }
      const methods = routeMethods(route, plugin.name);
      const pathMethods = methodsByPath.get(route.path) ?? new Set();
      if (
        pathMethods.has("ALL") ||
        (methods.includes("ALL") && pathMethods.size > 0)
      ) {
        throw new Error(
          `Trusted plugin route "${route.path}" conflicts with an ALL route for the same path`,
        );
      }
      for (const method of methods) {
        const key = `${method}:${route.path}`;
        if (seen.has(key)) {
          throw new Error(
            `Duplicate trusted plugin route "${method} ${route.path}"`,
          );
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
      `Trusted plugin "${pluginName}" slackConversationLink must return an absolute http(s) URL`,
      { cause: error },
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Trusted plugin "${pluginName}" slackConversationLink must return an absolute http(s) URL`,
    );
  }
  return parsed.toString();
}

/** Resolve the first trusted plugin conversation URL for finalized Slack footers. */
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

function dashboardReportText(
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

function dashboardReportTone(
  tone: DashboardPluginMetricTone | undefined,
): DashboardPluginMetricTone | undefined {
  return tone === "danger" ||
    tone === "good" ||
    tone === "neutral" ||
    tone === "warning"
    ? tone
    : undefined;
}

function sanitizeDashboardReport(args: {
  pluginName: string;
  report: DashboardPluginReportContent;
}): DashboardPluginReport {
  const summary = args.report.summary
    ?.slice(0, DASHBOARD_REPORT_MAX_SUMMARY_ITEMS)
    .map((metric) => {
      const label = dashboardReportText(
        metric.label,
        DASHBOARD_REPORT_MAX_LABEL_LENGTH,
      );
      const value = dashboardReportText(
        metric.value,
        DASHBOARD_REPORT_MAX_VALUE_LENGTH,
      );
      if (!label || !value) {
        return undefined;
      }
      const sanitizedMetric: NonNullable<
        DashboardPluginReport["summary"]
      >[number] = { label, value };
      const tone = dashboardReportTone(metric.tone);
      if (tone) {
        sanitizedMetric.tone = tone;
      }
      return sanitizedMetric;
    })
    .filter((metric): metric is NonNullable<typeof metric> => Boolean(metric));
  const sections = args.report.sections
    ?.slice(0, DASHBOARD_REPORT_MAX_SECTIONS)
    .map((section, sectionIndex) => {
      const title = dashboardReportText(
        section.title,
        DASHBOARD_REPORT_MAX_LABEL_LENGTH,
      );
      if (!title) {
        return undefined;
      }
      const columns = section.columns
        ?.slice(0, DASHBOARD_REPORT_MAX_COLUMNS)
        .map((column) => {
          const key = dashboardReportText(
            column.key,
            DASHBOARD_REPORT_MAX_LABEL_LENGTH,
          );
          const label = dashboardReportText(
            column.label,
            DASHBOARD_REPORT_MAX_LABEL_LENGTH,
          );
          return key && label ? { key, label } : undefined;
        })
        .filter((column): column is NonNullable<typeof column> =>
          Boolean(column),
        );
      const rows = section.rows
        ?.slice(0, DASHBOARD_REPORT_MAX_ROWS)
        .map((row, rowIndex) => {
          const id =
            dashboardReportText(row.id, DASHBOARD_REPORT_MAX_LABEL_LENGTH) ??
            `${sectionIndex}:${rowIndex}`;
          const cells = Object.fromEntries(
            (columns ?? []).map((column) => [
              column.key,
              dashboardReportText(
                row.cells[column.key],
                DASHBOARD_REPORT_MAX_VALUE_LENGTH,
              ) ?? "",
            ]),
          );
          const sanitizedRow: NonNullable<
            NonNullable<DashboardPluginReport["sections"]>[number]["rows"]
          >[number] = {
            cells,
            id,
          };
          const tone = dashboardReportTone(row.tone);
          if (tone) {
            sanitizedRow.tone = tone;
          }
          return sanitizedRow;
        });
      const sanitizedSection: NonNullable<
        DashboardPluginReport["sections"]
      >[number] = { title };
      if (columns?.length) {
        sanitizedSection.columns = columns;
      }
      const emptyText = dashboardReportText(
        section.emptyText,
        DASHBOARD_REPORT_MAX_VALUE_LENGTH,
      );
      if (emptyText) {
        sanitizedSection.emptyText = emptyText;
      }
      if (rows?.length) {
        sanitizedSection.rows = rows;
      }
      return sanitizedSection;
    })
    .filter((section): section is NonNullable<typeof section> =>
      Boolean(section),
    );

  const sanitized: DashboardPluginReport = {
    pluginName: args.pluginName,
  };
  const generatedAt = dashboardReportText(
    args.report.generatedAt,
    DASHBOARD_REPORT_MAX_VALUE_LENGTH,
  );
  if (generatedAt) {
    sanitized.generatedAt = generatedAt;
  }
  if (sections?.length) {
    sanitized.sections = sections;
  }
  if (summary?.length) {
    sanitized.summary = summary;
  }
  const title = dashboardReportText(
    args.report.title,
    DASHBOARD_REPORT_MAX_LABEL_LENGTH,
  );
  if (title) {
    sanitized.title = title;
  }
  return sanitized;
}

function failedDashboardReport(args: {
  nowMs: number;
  pluginName: string;
}): DashboardPluginReport {
  return {
    generatedAt: new Date(args.nowMs).toISOString(),
    pluginName: args.pluginName,
    summary: [{ label: "report", tone: "danger", value: "failed" }],
    title: args.pluginName,
    sections: [
      {
        emptyText: "This plugin report failed to load.",
        title: "Error",
      },
    ],
  };
}

/** Collect read-only dashboard summaries exposed by trusted plugins. */
export async function getAgentPluginDashboardReports(
  nowMs = Date.now(),
): Promise<DashboardPluginReport[]> {
  const reports: DashboardPluginReport[] = [];
  for (const plugin of getAgentPlugins()) {
    const hook = plugin.hooks?.dashboardReport;
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
        sanitizeDashboardReport({
          pluginName: plugin.name,
          report,
        }),
      );
    } catch (error) {
      log.error("Trusted plugin dashboard report failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      reports.push(failedDashboardReport({ nowMs, pluginName: plugin.name }));
    }
  }
  return reports;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

/** Create one runner over trusted agent plugins registered by the app. */
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
