import { promptMessageSchema } from "@sentry/junior-plugin-api";
import type {
  PluginConversations,
  PluginReadState,
  PluginRoute,
  PluginRouteMethod,
  PluginSandbox,
  PluginOperationalReport,
  PluginOperationalReportContent,
  PluginOperationalTone,
  PluginRouteApp,
  SlackConversationLink,
  PluginRegistration,
  SlackToolRegistrationHookContext,
  ToolRegistrationHookContext,
  UserPromptContext,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { logInfo, logWarn } from "@/chat/logging";
import { createPluginLogger } from "@/chat/plugins/logging";
import { createPluginEmbedder, createPluginModel } from "@/chat/plugins/model";
import type { PluginPromptContributionContext } from "@/chat/plugins/prompt";
import { createPluginState } from "@/chat/plugins/state";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import type { ToolDefinition } from "@/chat/tools/definition";
import { getSlackToolContext } from "@/chat/slack/tools/context";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import type {
  SandboxCommandInput,
  SandboxInstance,
} from "@/chat/sandbox/workspace";
import { createSlackDirectCredentialSubject } from "@/chat/credentials/subject";
import { resolveChannelCapabilities } from "@/chat/slack/tools/channel-capabilities";
import type { Requester } from "@/chat/requester";
import { z } from "zod";

/** Signal that a plugin intentionally denied a tool execution. */
export class PluginHookDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginHookDeniedError";
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

export interface PluginRouteRegistration extends PluginRoute {
  pluginName: string;
}

export interface PluginApiRouteRegistration {
  app: PluginRouteApp;
  pluginName: string;
}

export interface PluginHookRunner {
  beforeToolExecute(input: ToolHookInput): Promise<ToolHookResult>;
  prepareSandbox(sandbox: SandboxInstance): Promise<void>;
}

let registeredPlugins: PluginRegistration[] = [];
const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;
const PLUGIN_TOOL_NAME_RE = /^[a-z][A-Za-z0-9]*$/;
const OPERATIONAL_REPORT_MAX_METRICS = 8;
const OPERATIONAL_REPORT_MAX_RECORD_SETS = 8;
const OPERATIONAL_REPORT_MAX_FIELDS = 8;
const OPERATIONAL_REPORT_MAX_RECORDS = 25;
const OPERATIONAL_REPORT_MAX_LABEL_LENGTH = 80;
const OPERATIONAL_REPORT_MAX_VALUE_LENGTH = 160;
const PLUGIN_ROUTE_METHODS = new Set<PluginRouteMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "ALL",
]);
const PLUGIN_PROMPT_CONTRIBUTION_TOTAL_MAX_CHARS = 16_000;
const systemPromptMessageArraySchema = z.array(promptMessageSchema);
const userPromptMessageArraySchema = z.array(promptMessageSchema);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function basePluginContext(plugin: PluginRegistration) {
  const name = plugin.manifest.name;
  return {
    plugin: { name },
    log: createPluginLogger(name),
    db: getDb(),
  };
}

/** Convert manifest names into model-facing tool namespaces. */
function pluginToolNamespace(pluginName: string): string {
  const parts = pluginName.split("-").filter(Boolean);
  const [first = "plugin", ...rest] = parts;
  return `${first}${rest
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("")}`;
}

function systemPromptPluginContext(plugin: PluginRegistration) {
  return {
    ...basePluginContext(plugin),
  };
}

function invocationPluginContext(
  plugin: PluginRegistration,
  context: Pick<
    ToolRuntimeContext,
    "conversationId" | "destination" | "requester" | "source" | "userText"
  >,
): UserPromptContext {
  const base = basePluginContext(plugin);
  const common = {
    ...base,
    conversationId: context.conversationId,
    embedder: createPluginEmbedder(plugin.manifest.name),
    source: context.source,
    text: context.userText ?? "",
    state: createPluginState(plugin.manifest.name),
  };
  if (context.source.platform === "slack") {
    if (context.destination.platform !== "slack") {
      throw new TypeError(
        "Slack plugin prompt context requires Slack destination",
      );
    }
    return {
      ...common,
      destination: context.destination,
      requester:
        context.requester?.platform === "slack" ? context.requester : undefined,
    };
  }
  if (context.destination.platform !== "local") {
    throw new TypeError(
      "Local plugin prompt context requires local destination",
    );
  }
  return {
    ...common,
    destination: context.destination,
    requester:
      context.requester?.platform === "local" ? context.requester : undefined,
  };
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toPromptContributionContext(args: {
  hookName: "systemPrompt" | "userPrompt";
  index: number;
  message: z.output<typeof promptMessageSchema>;
  pluginName: string;
}): PluginPromptContributionContext {
  return {
    id: `${args.hookName}:${args.index}`,
    pluginName: args.pluginName,
    text: args.message.text,
  };
}

function logInvalidPromptContributions(args: {
  hookName: "systemPrompt" | "userPrompt";
  pluginName: string;
}): void {
  logWarn(
    "plugin_prompt_contribution_result_invalid",
    {},
    {
      "app.plugin.hook": args.hookName,
      "app.plugin.name": args.pluginName,
      "app.plugin.validation_reason": "invalid_shape",
    },
    "Plugin prompt contribution result invalid",
  );
}

/** Validate plugin identity before it can affect process-wide hooks. */
export function validatePlugins(plugins: PluginRegistration[]): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    const name = plugin.manifest.name;
    if (!PLUGIN_NAME_RE.test(name)) {
      throw new Error(
        `Plugin name "${name}" must be a lowercase plugin identifier`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate plugin name "${name}"`);
    }
    for (const [taskName, task] of Object.entries(plugin.tasks ?? {})) {
      if (!PLUGIN_TOOL_NAME_RE.test(taskName)) {
        throw new Error(
          `Plugin task "${taskName}" from plugin "${name}" must be a camelCase identifier`,
        );
      }
      if (typeof task.run !== "function") {
        throw new Error(
          `Plugin task "${taskName}" from plugin "${name}" must define a run function`,
        );
      }
    }
    seen.add(name);
  }
}

/** Replace runtime hook plugins and return the previous list for rollback. */
export function setPlugins(
  nextPlugins: PluginRegistration[],
): PluginRegistration[] {
  validatePlugins(nextPlugins);
  const previous = registeredPlugins;
  registeredPlugins = [...nextPlugins].sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name),
  );
  return previous;
}

/** Return the current runtime hook plugins without exposing mutable state. */
export function getPlugins(): PluginRegistration[] {
  return [...registeredPlugins];
}

/** Collect stable plugin prompt contributions for the static system prompt. */
export async function getPluginSystemPromptContributions(
  source: ToolRuntimeContext["source"],
): Promise<PluginPromptContributionContext[]> {
  const contributions: PluginPromptContributionContext[] = [];
  let totalChars = 0;
  for (const plugin of getPlugins()) {
    const pluginName = plugin.manifest.name;
    const hook = plugin.hooks?.systemPrompt;
    if (!hook) {
      continue;
    }
    try {
      const pluginContributions = await hook({
        ...systemPromptPluginContext(plugin),
        platform: source.platform,
      });
      const result =
        systemPromptMessageArraySchema.safeParse(pluginContributions);
      if (!result.success) {
        logInvalidPromptContributions({
          hookName: "systemPrompt",
          pluginName,
        });
        continue;
      }
      const acceptedContributions = result.data.map((message, index) =>
        toPromptContributionContext({
          hookName: "systemPrompt",
          index,
          message,
          pluginName,
        }),
      );
      const pluginContributionChars = acceptedContributions.reduce(
        (sum, contribution) => sum + contribution.text.length,
        0,
      );
      if (
        totalChars + pluginContributionChars >
        PLUGIN_PROMPT_CONTRIBUTION_TOTAL_MAX_CHARS
      ) {
        logWarn(
          "plugin_system_prompt_contribution_budget_exceeded",
          {},
          {
            "app.plugin.name": pluginName,
          },
          "Plugin system prompt contributions exceeded budget",
        );
        continue;
      }
      totalChars += pluginContributionChars;
      contributions.push(...acceptedContributions);
    } catch (error) {
      logWarn(
        "plugin_system_prompt_hook_failed",
        {},
        {
          "app.plugin.name": pluginName,
          "exception.message": safeErrorMessage(error),
        },
        "Plugin system prompt hook failed",
      );
    }
  }
  return contributions;
}

/** Collect request-scoped plugin prompt contributions. */
export async function getPluginUserPromptContributions(args: {
  context: Pick<
    ToolRuntimeContext,
    "conversationId" | "destination" | "requester" | "source" | "userText"
  >;
}): Promise<PluginPromptContributionContext[]> {
  const contributions: PluginPromptContributionContext[] = [];
  let totalChars = 0;
  for (const plugin of getPlugins()) {
    const pluginName = plugin.manifest.name;
    const hook = plugin.hooks?.userPrompt;
    if (!hook) {
      continue;
    }
    try {
      const rawResult = await hook({
        ...invocationPluginContext(plugin, args.context),
      });
      if (rawResult === undefined) {
        continue;
      }
      const result = userPromptMessageArraySchema.safeParse(rawResult);
      if (!result.success) {
        logInvalidPromptContributions({
          hookName: "userPrompt",
          pluginName,
        });
        continue;
      }

      const acceptedContributions = result.data.map((message, index) =>
        toPromptContributionContext({
          hookName: "userPrompt",
          index,
          message,
          pluginName,
        }),
      );
      const pluginContributionChars = acceptedContributions.reduce(
        (sum, contribution) => sum + contribution.text.length,
        0,
      );
      if (
        totalChars + pluginContributionChars >
        PLUGIN_PROMPT_CONTRIBUTION_TOTAL_MAX_CHARS
      ) {
        logWarn(
          "plugin_user_prompt_contribution_budget_exceeded",
          {},
          {
            "app.plugin.name": pluginName,
          },
          "Plugin user prompt contributions exceeded budget",
        );
        continue;
      }
      totalChars += pluginContributionChars;
      contributions.push(...acceptedContributions);
    } catch (error) {
      logWarn(
        "plugin_user_prompt_hook_failed",
        {},
        {
          "app.plugin.name": pluginName,
          "exception.message": safeErrorMessage(error),
        },
        "Plugin user prompt hook failed",
      );
    }
  }
  return contributions;
}

/** Collect turn-scoped tools exposed by plugins. */
export function getPluginTools(
  context: ToolRuntimeContext,
): Record<string, ToolDefinition<any>> {
  const tools: Record<string, ToolDefinition<any>> = {};
  for (const plugin of getPlugins()) {
    const pluginName = plugin.manifest.name;
    const hook = plugin.hooks?.tools;
    if (!hook) {
      continue;
    }
    const slackToolContext = getSlackToolContext(context);
    const credentialSubject = slackToolContext
      ? createSlackDirectCredentialSubject({
          channelId: slackToolContext.sourceChannelId,
          teamId: slackToolContext.teamId,
          userId: slackToolContext.requester?.userId,
        })
      : undefined;
    const slackContext: SlackToolRegistrationHookContext | undefined =
      slackToolContext
        ? {
            channelCapabilities: resolveChannelCapabilities(
              slackToolContext.sourceChannelId,
            ),
            ...(credentialSubject ? { credentialSubject } : {}),
          }
        : undefined;
    let pluginContext: ToolRegistrationHookContext;
    if (context.source.platform === "slack") {
      if (context.destination.platform !== "slack") {
        throw new TypeError(
          "Slack plugin tool context requires Slack destination",
        );
      }
      pluginContext = {
        ...basePluginContext(plugin),
        requester:
          context.requester?.platform === "slack"
            ? context.requester
            : undefined,
        conversationId: context.conversationId,
        destination: context.destination,
        slack: slackContext!,
        source: context.source,
        userText: context.userText,
        embedder: createPluginEmbedder(pluginName),
        egress: context.egress,
        model: createPluginModel(pluginName, plugin.model),
        state: createPluginState(pluginName),
      };
    } else {
      if (context.destination.platform !== "local") {
        throw new TypeError(
          "Local plugin tool context requires local destination",
        );
      }
      pluginContext = {
        ...basePluginContext(plugin),
        requester:
          context.requester?.platform === "local"
            ? context.requester
            : undefined,
        conversationId: context.conversationId,
        destination: context.destination,
        source: context.source,
        userText: context.userText,
        embedder: createPluginEmbedder(pluginName),
        egress: context.egress,
        model: createPluginModel(pluginName, plugin.model),
        state: createPluginState(pluginName),
      };
    }
    const pluginTools = hook(pluginContext);
    const namespace = pluginToolNamespace(pluginName);
    for (const [localName, tool] of Object.entries(pluginTools)) {
      if (!PLUGIN_TOOL_NAME_RE.test(localName)) {
        throw new Error(
          `Plugin tool "${localName}" from plugin "${pluginName}" must be a camelCase identifier`,
        );
      }
      const name = `${namespace}_${localName}`;
      if (tools[name]) {
        throw new Error(
          `Duplicate plugin tool "${name}" from plugin "${pluginName}"`,
        );
      }
      const definition = tool as unknown as ToolDefinition<any>;
      definition.identity = {
        id: `${pluginName}.${localName}`,
        name: localName,
        plugin: pluginName,
      };
      tools[name] = definition;
    }
  }
  return tools;
}

/** Normalize route methods so JS plugins cannot register invalid verbs. */
function routeMethods(
  route: PluginRoute,
  pluginName: string,
): PluginRouteMethod[] {
  const methods = Array.isArray(route.method)
    ? route.method
    : [route.method ?? "ALL"];
  if (methods.length === 0) {
    throw new Error(
      `Plugin route "${route.path}" from plugin "${pluginName}" must declare at least one method`,
    );
  }

  for (const method of methods) {
    if (!PLUGIN_ROUTE_METHODS.has(method)) {
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
export function getPluginRoutes(): PluginRouteRegistration[] {
  const routes: PluginRouteRegistration[] = [];
  const seen = new Set<string>();
  const methodsByPath = new Map<string, Set<PluginRouteMethod>>();

  for (const plugin of getPlugins()) {
    const pluginName = plugin.manifest.name;
    const hook = plugin.hooks?.routes;
    if (!hook) {
      continue;
    }
    const pluginRoutes = hook({
      ...basePluginContext(plugin),
    });
    if (!Array.isArray(pluginRoutes)) {
      throw new Error(
        `Plugin routes hook from plugin "${pluginName}" must return an array`,
      );
    }
    for (const route of pluginRoutes) {
      if (!isRecord(route)) {
        throw new Error(
          `Plugin route from plugin "${pluginName}" must be an object`,
        );
      }
      if (typeof route.path !== "string" || !route.path.startsWith("/")) {
        throw new Error(
          `Plugin route "${route.path}" from plugin "${pluginName}" must start with /`,
        );
      }
      if (typeof route.handler !== "function") {
        throw new Error(
          `Plugin route "${route.path}" from plugin "${pluginName}" must provide a handler`,
        );
      }
      const methods = routeMethods(route, pluginName);
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
        pluginName,
      });
    }
  }

  return routes;
}

/** Collect authenticated product API route apps exposed by plugins. */
export function getPluginApiRoutes(): PluginApiRouteRegistration[] {
  const routes: PluginApiRouteRegistration[] = [];

  for (const plugin of getPlugins()) {
    const pluginName = plugin.manifest.name;
    const hook = plugin.hooks?.apiRoutes;
    if (!hook) {
      continue;
    }
    const app = hook({
      ...basePluginContext(plugin),
    });
    if (app === undefined) {
      continue;
    }
    if (!isRecord(app) || typeof app.fetch !== "function") {
      throw new Error(
        `Plugin apiRoutes hook from plugin "${pluginName}" must return a fetch-compatible app`,
      );
    }
    routes.push({ app, pluginName });
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
export function getPluginSlackConversationLink(
  conversationId: string,
): SlackConversationLink | undefined {
  for (const plugin of getPlugins()) {
    const pluginName = plugin.manifest.name;
    const hook = plugin.hooks?.slackConversationLink;
    if (!hook) {
      continue;
    }
    const link = hook({
      ...basePluginContext(plugin),
      conversationId,
    });
    const url = trustedSlackConversationUrl(pluginName, link);
    if (url) {
      return { url };
    }
  }
  return undefined;
}

function pluginReadState(state: { get: PluginReadState["get"] }) {
  return {
    get: state.get,
  } satisfies PluginReadState;
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
export async function getPluginOperationalReports(
  nowMs: number,
  conversations: PluginConversations,
): Promise<PluginOperationalReport[]> {
  const reports: PluginOperationalReport[] = [];
  for (const plugin of getPlugins()) {
    const pluginName = plugin.manifest.name;
    const hook = plugin.hooks?.operationalReport;
    if (!hook) {
      continue;
    }
    try {
      const state = createPluginState(pluginName);
      const report = await hook({
        ...basePluginContext(plugin),
        conversations,
        nowMs,
        state: pluginReadState(state),
      });
      if (!report) {
        continue;
      }
      reports.push(
        sanitizeOperationalReport({
          pluginName,
          report,
        }),
      );
    } catch (error) {
      const log = createPluginLogger(pluginName);
      log.error("Plugin operational report failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      reports.push(failedOperationalReport({ nowMs, pluginName }));
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

function createSandboxCapability(sandbox: SandboxInstance): PluginSandbox {
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
export function createPluginHookRunner(
  input: {
    requester?: Requester;
  } = {},
): PluginHookRunner {
  const loaded = getPlugins();

  return {
    async prepareSandbox(sandbox) {
      const sandboxCapability = createSandboxCapability(sandbox);
      for (const plugin of loaded) {
        const pluginName = plugin.manifest.name;
        const hook = plugin.hooks?.sandboxPrepare;
        if (!hook) {
          continue;
        }
        logInfo(
          "agent_plugin_hook_sandbox_prepare",
          {},
          { "app.plugin.name": pluginName },
          "Running agent plugin sandbox prepare hook",
        );
        await hook({
          ...basePluginContext(plugin),
          requester: input.requester,
          sandbox: sandboxCapability,
        });
      }
    },
    async beforeToolExecute(tool) {
      let nextInput = { ...tool.input };
      const env = normalizeEnv(nextInput.env);

      for (const plugin of loaded) {
        const pluginName = plugin.manifest.name;
        const hook = plugin.hooks?.beforeToolExecute;
        if (!hook) {
          continue;
        }
        let replacement: Record<string, unknown> | undefined;
        let denied: string | undefined;
        await hook({
          ...basePluginContext(plugin),
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
          throw new PluginHookDeniedError(denied);
        }
        if (replacement !== undefined) {
          if (!isRecord(replacement)) {
            throw new Error(
              `Plugin "${pluginName}" replaced tool input with a non-object value`,
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
