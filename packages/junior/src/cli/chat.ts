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
import * as readline from "node:readline/promises";
import type { AssistantReply } from "@/chat/respond";
import { normalizeLocalConversationId } from "@/chat/local/conversation";

export const CHAT_USAGE =
  "usage: junior chat [--conversation <name>]\n       junior chat [--conversation <name>] --once <message>";

export interface ChatCommandOptions {
  conversation: string;
  message?: string;
  mode: "interactive" | "once";
}

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

function defaultStateAdapterForLocalChat(): void {
  if (process.env.JUNIOR_STATE_ADAPTER || process.env.REDIS_URL) {
    return;
  }
  process.env.JUNIOR_STATE_ADAPTER = "memory";
}

function parseChatArgs(argv: string[]): ChatCommandOptions | undefined {
  let conversation = "default";
  let message: string | undefined;
  let mode: ChatCommandOptions["mode"] = "interactive";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--conversation") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        return undefined;
      }
      conversation = value;
      index += 1;
      continue;
    }

    if (arg === "--once") {
      const rest = argv.slice(index + 1);
      if (rest.length === 0 || rest.some((value) => value.startsWith("--"))) {
        return undefined;
      }
      message = rest.join(" ");
      mode = "once";
      break;
    }

    return undefined;
  }

  if (!normalizeLocalConversationId({ alias: conversation })) {
    return undefined;
  }

  return { conversation, ...(message ? { message } : {}), mode };
}

function formatReply(reply: AssistantReply): string {
  const lines: string[] = [];
  const text = reply.text.trim();
  if (text) {
    lines.push(text);
  }

  for (const file of reply.files ?? []) {
    const filename =
      typeof file.filename === "string" && file.filename.trim()
        ? file.filename
        : "generated file";
    lines.push(`Generated file: ${filename}`);
  }

  return `${lines.join("\n") || "[empty response]"}\n`;
}

async function runOnce(
  options: ChatCommandOptions & { message: string },
  io: ChatIo,
): Promise<number> {
  defaultStateAdapterForLocalChat();
  const conversationId = normalizeLocalConversationId({
    alias: options.conversation,
  });
  if (!conversationId) {
    throw new Error("Invalid local conversation name");
  }

  const { runLocalAgentTurn } = await import("@/chat/local/runner");
  const result = await runLocalAgentTurn(
    {
      conversationAlias: options.conversation,
      conversationId,
      message: options.message,
      mode: "once",
    },
    {
      deliverReply: async (reply) => {
        await io.write(formatReply(reply));
      },
      onStatus: async (status) => {
        await io.error(status);
      },
    },
  );
  return result.reply.diagnostics.outcome === "success" ? 0 : 1;
}

async function runInteractive(
  options: ChatCommandOptions,
  io: ChatIo,
): Promise<void> {
  defaultStateAdapterForLocalChat();
  const conversationId = normalizeLocalConversationId({
    alias: options.conversation,
  });
  if (!conversationId) {
    throw new Error("Invalid local conversation name");
  }

  const { runLocalAgentTurn } = await import("@/chat/local/runner");
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
      await runLocalAgentTurn(
        {
          conversationAlias: options.conversation,
          conversationId,
          message,
          mode: "interactive",
        },
        {
          deliverReply: async (reply) => {
            await io.write(formatReply(reply));
          },
          onStatus: async (status) => {
            await io.error(status);
          },
        },
      );
    }
  } finally {
    rl.close();
  }
}

/** Run the local Junior chat command. */
export async function runChat(
  argv: string[],
  io: ChatIo = DEFAULT_IO,
): Promise<number> {
  const options = parseChatArgs(argv);
  if (!options) {
    await io.error(CHAT_USAGE);
    return 1;
  }

  try {
    if (options.mode === "once") {
      if (!options.message) {
        await io.error(CHAT_USAGE);
        return 1;
      }
      return await runOnce(
        options as ChatCommandOptions & { message: string },
        io,
      );
    }
    await runInteractive(options, io);
    return 0;
  } catch (error) {
    await io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
