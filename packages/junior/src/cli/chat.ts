/**
 * Local chat CLI command.
 *
 * This module owns terminal argument parsing and output delivery for `junior
 * chat`; the agent runtime stays behind the local runner, and invalid CLI input
 * must fail before conversation state is created.
 */
import {
  stdin as defaultStdin,
  stderr as defaultStderr,
  stdout as defaultStdout,
} from "node:process";
import { randomUUID } from "node:crypto";
import * as readline from "node:readline/promises";
import { createJiti } from "jiti";
import { loadAppPluginSet } from "@/plugin-module";
import { normalizeLocalConversationId } from "@/chat/local/conversation";
import type {
  LocalAgentReply,
  LocalAgentTurnDeps,
  LocalToolResult,
} from "@/chat/local/runner";
import { generateAssistantReply } from "@/chat/respond";
import { createAgentRunner } from "@/chat/runtime/agent-runner";
import type { JuniorPluginSet } from "@/plugins";

export const CHAT_USAGE = "usage: junior chat\n       junior chat -p <message>";

export type ChatCommandOptions =
  | { mode: "interactive" }
  | { message: string; mode: "prompt" };

export interface ChatIo {
  error: (line: string) => Promise<void> | void;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  write: (text: string) => Promise<void> | void;
}

const DEFAULT_IO: ChatIo = {
  error: (line) => writeStream(defaultStderr, `${line}\n`),
  input: defaultStdin,
  output: defaultStdout,
  write: (text) => writeStream(defaultStdout, text),
};
const localPluginLoader = createJiti(import.meta.url, { moduleCache: false });

class ChatOutputError extends Error {
  constructor(error: unknown) {
    super(errorMessage(error));
    this.name = "ChatOutputError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Deliver text-only local replies and turn unsupported files/output errors into failed delivery. */
async function deliverReply(io: ChatIo, reply: LocalAgentReply): Promise<void> {
  try {
    const files = reply.files ?? [];
    if (files.length > 0) {
      const names = files
        .map((file) =>
          typeof file.filename === "string" && file.filename.trim()
            ? file.filename
            : "generated file",
        )
        .join(", ");
      throw new Error(`Local chat cannot deliver files yet: ${names}`);
    }
    await io.write(formatReply(reply));
  } catch (error) {
    throw new ChatOutputError(error);
  }
}

async function reportStatus(io: ChatIo, status: string): Promise<void> {
  try {
    await io.error(status);
  } catch (error) {
    throw new ChatOutputError(error);
  }
}

function formatToolPayload(payload: unknown): string {
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.keys(payload).length === 0
  ) {
    return "";
  }
  const rendered = JSON.stringify(payload);
  if (rendered.length <= 500) {
    return ` ${rendered}`;
  }
  return ` ${rendered.slice(0, 497)}...`;
}

async function reportToolResult(
  io: ChatIo,
  result: LocalToolResult,
): Promise<void> {
  if (!result.ok) {
    await reportStatus(
      io,
      `tool: ${result.toolName} error ${result.error ?? "Tool execution failed"}`,
    );
    return;
  }
  await reportStatus(
    io,
    `tool: ${result.toolName} ok${formatToolPayload(result.result ?? {})}`,
  );
}

function writeStream(
  stream: NodeJS.WritableStream,
  text: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/** Keep local chat ephemeral by default; Redis is opt-in via an explicit adapter. */
function defaultStateAdapterForLocalChat(): void {
  if (process.env.JUNIOR_STATE_ADAPTER) {
    return;
  }
  process.env.JUNIOR_STATE_ADAPTER = "memory";
}

/** Load the app plugin module so source-mode local chat matches server wiring. */
async function loadLocalPluginSet(): Promise<JuniorPluginSet | undefined> {
  return await loadAppPluginSet(process.cwd(), async (moduleRef) =>
    localPluginLoader.import<Record<string, unknown>>(moduleRef.importPath),
  );
}

/** Configure plugin hooks after local chat has selected its state adapter. */
async function configureLocalChatPlugins(
  pluginSet?: JuniorPluginSet | null,
): Promise<void> {
  const [
    pluginsModule,
    agentHooksModule,
    catalogRuntimeModule,
    validationModule,
    databaseModule,
  ] = await Promise.all([
    import("@/plugins"),
    import("@/chat/plugins/agent-hooks"),
    import("@/chat/plugins/catalog-runtime"),
    import("@/chat/plugins/validation"),
    import("@/chat/db"),
  ]);
  const resolvedPluginSet =
    pluginSet === undefined
      ? await loadLocalPluginSet()
      : (pluginSet ?? undefined);
  const plugins =
    pluginsModule.pluginRuntimeRegistrationsFromPluginSet(resolvedPluginSet);
  const pluginConfig = resolvedPluginSet
    ? pluginsModule.pluginCatalogConfigFromPluginSet(resolvedPluginSet)
    : pluginsModule.pluginCatalogConfigFromEnv();
  const shouldValidatePluginCatalog =
    Boolean(pluginConfig) || Boolean(resolvedPluginSet?.registrations.length);
  agentHooksModule.validatePlugins(plugins);
  const previousPluginCatalogConfig =
    catalogRuntimeModule.pluginCatalogRuntime.setConfig(pluginConfig);
  try {
    if (shouldValidatePluginCatalog) {
      catalogRuntimeModule.pluginCatalogRuntime.getSignature();
      validationModule.validatePluginRegistrations(
        resolvedPluginSet?.registrations ?? [],
      );
      validationModule.validatePluginEgressCredentialHooks(
        resolvedPluginSet?.registrations ?? [],
      );
    }
    databaseModule.getDb();
    agentHooksModule.setPlugins(plugins);
  } catch (error) {
    catalogRuntimeModule.pluginCatalogRuntime.setConfig(
      previousPluginCatalogConfig,
    );
    throw error;
  }
}

function parseChatArgs(argv: string[]): ChatCommandOptions | undefined {
  if (argv.length === 0) {
    return { mode: "interactive" };
  }

  if (argv[0] !== "-p") {
    return undefined;
  }

  const message = argv.slice(1).join(" ").trim();
  if (!message) {
    return undefined;
  }

  return { message, mode: "prompt" };
}

function formatReply(reply: LocalAgentReply): string {
  const lines: string[] = [];
  const text = reply.text.trim();
  if (text) {
    lines.push(text);
  }

  return `${lines.join("\n") || "[empty response]"}\n`;
}

/** Create a fresh local conversation id for one CLI process invocation. */
function newRunConversationId(): string {
  const conversationId = normalizeLocalConversationId({
    alias: `run-${randomUUID()}`,
  });
  if (!conversationId) {
    throw new Error("Invalid local conversation name");
  }
  return conversationId;
}

/** Wire the shared local-turn setup so prompt and interactive runs stay identical. */
async function prepareLocalChatRun(
  io: ChatIo,
  pluginSet: JuniorPluginSet | null | undefined,
) {
  defaultStateAdapterForLocalChat();
  await configureLocalChatPlugins(pluginSet);
  const { runLocalAgentTurn } = await import("@/chat/local/runner");
  const deps: LocalAgentTurnDeps = {
    agentRunner: createAgentRunner(generateAssistantReply),
    deliverReply: async (reply) => {
      await deliverReply(io, reply);
    },
    onStatus: async (status) => {
      await reportStatus(io, status);
    },
    onToolResult: async (result) => {
      await reportToolResult(io, result);
    },
  };
  return { conversationId: newRunConversationId(), runLocalAgentTurn, deps };
}

async function runPrompt(
  options: Extract<ChatCommandOptions, { mode: "prompt" }>,
  io: ChatIo,
  pluginSet: JuniorPluginSet | null | undefined,
): Promise<number> {
  const { conversationId, runLocalAgentTurn, deps } = await prepareLocalChatRun(
    io,
    pluginSet,
  );
  const result = await runLocalAgentTurn(
    {
      conversationId,
      message: options.message,
    },
    deps,
  );
  return result.outcome === "success" ? 0 : 1;
}

async function runInteractive(
  io: ChatIo,
  pluginSet: JuniorPluginSet | null | undefined,
): Promise<void> {
  const { conversationId, runLocalAgentTurn, deps } = await prepareLocalChatRun(
    io,
    pluginSet,
  );
  const rl = readline.createInterface({
    input: io.input,
    output: io.output,
    terminal: true,
  });
  try {
    while (true) {
      const message = (await rl.question("junior> ")).trim();
      if (!message) {
        continue;
      }
      if (message === "/exit" || message === "/quit") {
        break;
      }
      try {
        await runLocalAgentTurn(
          {
            conversationId,
            message,
          },
          deps,
        );
      } catch (error) {
        if (error instanceof ChatOutputError) {
          throw error;
        }
        await reportStatus(io, errorMessage(error));
      }
    }
  } finally {
    rl.close();
  }
}

/** Run the local Junior chat command. */
export async function runChat(
  argv: string[],
  io: ChatIo = DEFAULT_IO,
  deps: { pluginSet?: JuniorPluginSet | null } = {},
): Promise<number> {
  const options = parseChatArgs(argv);
  if (!options) {
    await io.error(CHAT_USAGE);
    return 1;
  }

  try {
    if (options.mode === "prompt") {
      return await runPrompt(options, io, deps.pluginSet);
    }
    await runInteractive(io, deps.pluginSet);
    return 0;
  } catch (error) {
    await io.error(errorMessage(error));
    return 1;
  }
}
