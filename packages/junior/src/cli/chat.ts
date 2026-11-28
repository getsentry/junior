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
import { installChatConfig } from "@/chat/config";
import type { ConfigInput } from "@/config";
import { normalizeLocalConversationId } from "@/chat/local/conversation";
import type {
  LocalAgentReply,
  LocalAgentTurnDeps,
  LocalToolResult,
} from "@/chat/local/runner";
import { executeAgentRun } from "@/chat/agent";
import { createAgentRunner } from "@/chat/runtime/agent-runner";
import { pluginCatalogConfigFromEnv, type JuniorPluginSet } from "@/plugins";
import {
  validatePluginEgressCredentialHooks,
  validatePluginRegistrations,
} from "@/chat/plugins/validation";
import type { AppContext } from "@/app/context";
import { withCliAppContext } from "./context";

export const CHAT_USAGE =
  "usage: junior chat\n       junior chat -p <message>\n       junior chat --engine core -p <message>";

export type ChatCommandOptions =
  | { mode: "interactive" }
  | { message: string; mode: "prompt" }
  | { message: string; mode: "core_prompt" };

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

/** Deliver text-only local replies. */
async function deliverReply(io: ChatIo, reply: LocalAgentReply): Promise<void> {
  try {
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

/** Load the app plugin module so source-mode local chat matches server wiring. */
async function loadLocalPluginSet(): Promise<JuniorPluginSet | undefined> {
  return await loadAppPluginSet(process.cwd(), async (moduleRef) =>
    localPluginLoader.import<Record<string, unknown>>(moduleRef.importPath),
  );
}

/**
 * Run a local chat command with its app context. Local chat is ephemeral by
 * default: it uses the memory state adapter unless `JUNIOR_STATE_ADAPTER` is
 * set, so Redis is opt-in.
 */
async function withLocalChatContext<T>(
  pluginSet: JuniorPluginSet | null | undefined,
  options: ConfigInput,
  run: (context: AppContext) => Promise<T>,
): Promise<T> {
  const resolvedPluginSet =
    pluginSet === undefined
      ? await loadLocalPluginSet()
      : (pluginSet ?? undefined);
  const config: ConfigInput = {
    ...options,
    state: {
      adapter: process.env["JUNIOR_STATE_ADAPTER"] ? undefined : "memory",
    },
  };
  return await withCliAppContext(
    { config, pluginSet: resolvedPluginSet },
    async (context) => {
      const previousChatConfig = installChatConfig(context.config);
      try {
        if (resolvedPluginSet || pluginCatalogConfigFromEnv()) {
          const registrations = resolvedPluginSet?.registrations ?? [];
          context.catalog.getSignature();
          validatePluginRegistrations(context.catalog, registrations);
          validatePluginEgressCredentialHooks(context.catalog, registrations);
        }
        context.sql.db();
        return await run(context);
      } finally {
        installChatConfig(previousChatConfig);
      }
    },
  );
}

function parseChatArgs(argv: string[]): ChatCommandOptions | undefined {
  if (argv.length === 0) {
    return { mode: "interactive" };
  }

  const coreEngine = argv[0] === "--engine" && argv[1] === "core";
  const promptArgs = coreEngine ? argv.slice(2) : argv;
  if (promptArgs[0] !== "-p") {
    return undefined;
  }

  const message = promptArgs.slice(1).join(" ").trim();
  if (!message) {
    return undefined;
  }

  return { message, mode: coreEngine ? "core_prompt" : "prompt" };
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

function localDevServerUrl(): string {
  return `http://127.0.0.1:${process.env["PORT"]?.trim() || "3000"}`;
}

/** Wire the shared local-turn setup so prompt and interactive runs stay identical. */
async function prepareLocalChatRun(
  io: ChatIo,
  context: Pick<AppContext, "catalog">,
) {
  const { runLocalAgentTurn } = await import("@/chat/local/runner");
  const { startLocalOAuthCallbackServer } =
    await import("@/chat/local/oauth-callback-server");
  const { createLocalOAuthState } = await import("@/chat/local/oauth-relay");
  const { createLocalSandboxEgressSignalTransport } =
    await import("@/chat/local/sandbox-egress-signals");
  const { bindSpawnAgent } = await import("@/chat/child-agents/spawn");
  const { bindMessageAgent } = await import("@/chat/child-agents/message");
  const { runConversation } =
    await import("@/chat/task-execution/run-conversation");
  const { createConversationTurnWorker } =
    await import("@/chat/task-execution/conversation-turn");
  const { resumeForPersonInput } =
    await import("@/chat/conversations/session-stop");
  const { createLocalConversationWork } =
    await import("@/chat/local/conversation-work");
  const { processConversationWork } =
    await import("@/chat/task-execution/worker");
  let agentRunner: ReturnType<typeof createAgentRunner> | undefined;
  const localConversationWork = createLocalConversationWork(async (message) => {
    if (!agentRunner) {
      throw new Error("Local agent runner is not ready");
    }
    const runTurn = createConversationTurnWorker(agentRunner, undefined, {
      queue: localConversationWork.queue,
    });
    await processConversationWork(message, {
      queue: localConversationWork.queue,
      // The local queue carries only child Conversation work.
      run: async (context) => {
        await resumeForPersonInput(
          context.conversationId,
          context.attempt.messages,
        );
        return await runConversation(context, { runTurn });
      },
    });
  });
  agentRunner = createAgentRunner(executeAgentRun, {
    // The local CLI does not send child results or messages back to the
    // root Conversation, so a Turn that can message its parent gets no
    // messageAgent here.
    bindMessageAgent: (request, agents) =>
      agents === "children_and_parent"
        ? undefined
        : bindMessageAgent(request, { queue: localConversationWork.queue }),
    bindSpawnAgent: (request) =>
      bindSpawnAgent(request, { queue: localConversationWork.queue }),
  });
  const oauthCallback = await startLocalOAuthCallbackServer(context.catalog);
  const deps: LocalAgentTurnDeps = {
    agentRunner,
    authorization: {
      cancel: oauthCallback.cancelAuthorization,
      createState: async () => await createLocalOAuthState(oauthCallback.port),
      deliver: async (request) => {
        oauthCallback.beginAuthorization(request.authorizationUrl);
        await reportStatus(
          io,
          `${request.label}:\n${request.authorizationUrl}\n${request.completionText}`,
        );
      },
      wait: oauthCallback.waitForAuthorization,
    },
    sandboxEgressSignals:
      createLocalSandboxEgressSignalTransport(localDevServerUrl()),
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
  return {
    close: async () => {
      try {
        await localConversationWork.drain();
      } finally {
        await oauthCallback.close();
      }
    },
    conversationId: newRunConversationId(),
    runLocalAgentTurn,
    deps,
  };
}

// Prompt and interactive runs embed events, like a deployed app can.
const LOCAL_RUN_CONFIG: ConfigInput = { eventEmbeddings: { enabled: true } };

async function runPrompt(
  options: Extract<ChatCommandOptions, { mode: "prompt" }>,
  io: ChatIo,
  pluginSet: JuniorPluginSet | null | undefined,
): Promise<number> {
  return await withLocalChatContext(
    pluginSet,
    LOCAL_RUN_CONFIG,
    async (context) => {
      const { close, conversationId, runLocalAgentTurn, deps } =
        await prepareLocalChatRun(io, context);
      try {
        const result = await runLocalAgentTurn(
          {
            conversationId,
            message: options.message,
          },
          deps,
        );
        return result.outcome === "success" ? 0 : 1;
      } finally {
        await close();
      }
    },
  );
}

async function runCorePrompt(
  options: Extract<ChatCommandOptions, { mode: "core_prompt" }>,
  io: ChatIo,
  pluginSet: JuniorPluginSet | null | undefined,
): Promise<number> {
  return await withLocalChatContext(pluginSet, {}, async (context) => {
    const { runCoreEnginePrompt } = await import("./chat-core-engine");
    const result = await runCoreEnginePrompt(context.config, {
      conversationId: newRunConversationId(),
      message: options.message,
    });
    if (result.outcome !== "completed") {
      await reportStatus(io, `Turn ${result.outcome}: ${result.reason}`);
      return 1;
    }
    await deliverReply(io, { text: result.reply });
    return 0;
  });
}

async function runInteractive(
  io: ChatIo,
  pluginSet: JuniorPluginSet | null | undefined,
): Promise<void> {
  await withLocalChatContext(pluginSet, LOCAL_RUN_CONFIG, async (context) => {
    const { close, conversationId, runLocalAgentTurn, deps } =
      await prepareLocalChatRun(io, context);
    const rl = readline.createInterface({
      input: io.input,
      output: io.output,
      terminal: true,
    });
    try {
      /* oxlint-disable no-await-in-loop -- The REPL reads and runs one message at a time. */
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
      /* oxlint-enable no-await-in-loop */
    } finally {
      rl.close();
      await close();
    }
  });
}

/** Run the local Junior chat command. */
export async function runChat(
  argv: string[],
  io: ChatIo = DEFAULT_IO,
  deps: { pluginSet?: JuniorPluginSet | null | undefined } = {},
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
    if (options.mode === "core_prompt") {
      return await runCorePrompt(options, io, deps.pluginSet);
    }
    await runInteractive(io, deps.pluginSet);
    return 0;
  } catch (error) {
    await io.error(errorMessage(error));
    return 1;
  }
}
