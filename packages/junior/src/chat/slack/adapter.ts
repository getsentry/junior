import {
  createSlackAdapter,
  type SlackAdapter,
  type SlackAdapterConfig,
} from "@chat-adapter/slack";
import {
  StreamingMarkdownRenderer,
  type SentMessage,
  type StreamChunk,
  type StreamOptions,
} from "chat";

const STREAM_BUFFER_SIZE = 64;
const CLIENT_STREAM_PATCHED = Symbol("junior.slack.client_stream_patched");
const ADAPTER_STREAM_PATCHED = Symbol("junior.slack.adapter_stream_patched");

type SlackClientWithStream = {
  [CLIENT_STREAM_PATCHED]?: boolean;
  chatStream: (params: Record<string, unknown>) => {
    append: (args: Record<string, unknown>) => Promise<unknown>;
    stop: (args?: Record<string, unknown>) => Promise<{
      message?: { ts?: string };
      ts?: string;
    }>;
  };
};

type SlackAdapterInternals = {
  [ADAPTER_STREAM_PATCHED]?: boolean;
  client: SlackClientWithStream;
  decodeThreadId: (threadId: string) => { channel: string; threadTs: string };
  getToken: () => string;
  logger: {
    debug: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
  stream: (
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    options?: StreamOptions,
  ) => Promise<SentMessage>;
};

function assertSlackAdapterInternals(
  internals: Partial<SlackAdapterInternals>,
): asserts internals is SlackAdapterInternals {
  if (!internals.client || typeof internals.client.chatStream !== "function") {
    throw new Error("Slack adapter client does not expose chatStream()");
  }
  if (typeof internals.stream !== "function") {
    throw new Error("Slack adapter does not expose stream()");
  }
  if (typeof internals.decodeThreadId !== "function") {
    throw new Error("Slack adapter does not expose decodeThreadId()");
  }
  if (typeof internals.getToken !== "function") {
    throw new Error("Slack adapter does not expose getToken()");
  }
  if (
    !internals.logger ||
    typeof internals.logger.debug !== "function" ||
    typeof internals.logger.warn !== "function"
  ) {
    throw new Error("Slack adapter does not expose logger debug/warn methods");
  }
}

function shouldEagerFlushPlainText(text: string): boolean {
  return text.length > 0 && !text.includes("\n") && !/[`*~[\]|]/.test(text);
}

function getNextRenderableDelta(
  renderer: StreamingMarkdownRenderer,
  lastAppended: string,
): { delta: string; nextAppended: string } {
  const committable = renderer.getCommittableText();
  if (committable.startsWith(lastAppended)) {
    const delta = committable.slice(lastAppended.length);
    if (delta) {
      return { delta, nextAppended: committable };
    }
  }

  const rawText = renderer.getText();
  if (
    shouldEagerFlushPlainText(rawText) &&
    rawText.startsWith(lastAppended) &&
    rawText.length > lastAppended.length
  ) {
    return {
      delta: rawText.slice(lastAppended.length),
      nextAppended: rawText,
    };
  }

  return { delta: "", nextAppended: lastAppended };
}

function patchSlackClientStream(adapter: SlackAdapter): void {
  const internals = adapter as unknown as SlackAdapterInternals;
  const { client } = internals;
  if (client[CLIENT_STREAM_PATCHED]) {
    return;
  }

  const originalChatStream = client.chatStream.bind(client);
  client.chatStream = (params) =>
    originalChatStream({
      ...params,
      buffer_size: STREAM_BUFFER_SIZE,
    });
  client[CLIENT_STREAM_PATCHED] = true;
}

function patchSlackAdapterStream(adapter: SlackAdapter): void {
  const internals = adapter as unknown as SlackAdapterInternals;
  if (internals[ADAPTER_STREAM_PATCHED]) {
    return;
  }

  const originalStream = internals.stream.bind(adapter);
  internals.stream = async function (
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    options?: StreamOptions,
  ): Promise<SentMessage> {
    if (!(options?.recipientUserId && options?.recipientTeamId)) {
      return originalStream(threadId, textStream, options);
    }

    const { channel, threadTs } = internals.decodeThreadId(threadId);
    internals.logger.debug("Slack: starting stream", { channel, threadTs });

    const token = internals.getToken();
    const streamer = internals.client.chatStream({
      channel,
      thread_ts: threadTs,
      recipient_user_id: options.recipientUserId,
      recipient_team_id: options.recipientTeamId,
      ...(options.taskDisplayMode
        ? { task_display_mode: options.taskDisplayMode }
        : {}),
    });

    let first = true;
    let lastAppended = "";
    let structuredChunksSupported = true;
    const renderer = new StreamingMarkdownRenderer({
      wrapTablesForAppend: false,
    });

    const flushMarkdownDelta = async (delta: string): Promise<void> => {
      if (delta.length === 0) {
        return;
      }
      if (first) {
        await streamer.append({ markdown_text: delta, token, chunks: [] });
        first = false;
        return;
      }
      await streamer.append({ markdown_text: delta });
    };

    const flushText = async (): Promise<void> => {
      const { delta, nextAppended } = getNextRenderableDelta(
        renderer,
        lastAppended,
      );
      await flushMarkdownDelta(delta);
      lastAppended = nextAppended;
    };

    const sendStructuredChunk = async (chunk: StreamChunk): Promise<void> => {
      if (!structuredChunksSupported) {
        return;
      }

      await flushText();

      try {
        if (first) {
          await streamer.append({ chunks: [chunk], token });
          first = false;
          return;
        }
        await streamer.append({ chunks: [chunk] });
      } catch (error) {
        structuredChunksSupported = false;
        internals.logger.warn(
          "Structured streaming chunk failed, falling back to text-only streaming. Ensure your Slack app manifest includes assistant_view, assistant:write scope, and @slack/web-api >= 7.14.0",
          { chunkType: chunk.type, error },
        );
      }
    };

    const pushTextAndFlush = async (text: string): Promise<void> => {
      renderer.push(text);
      await flushText();
    };

    for await (const chunk of textStream) {
      if (typeof chunk === "string") {
        await pushTextAndFlush(chunk);
      } else if (chunk.type === "markdown_text") {
        await pushTextAndFlush(chunk.text);
      } else {
        await sendStructuredChunk(chunk);
      }
    }

    renderer.finish();
    await flushText();

    const result = await streamer.stop(
      options?.stopBlocks ? { blocks: options.stopBlocks } : undefined,
    );
    const messageTs = result.message?.ts ?? result.ts;
    internals.logger.debug("Slack: stream complete", { messageId: messageTs });

    return {
      id: messageTs,
      threadId,
      raw: result,
    } as SentMessage;
  };
  internals[ADAPTER_STREAM_PATCHED] = true;
}

/**
 * Create the Slack adapter with Junior's stream buffering policy applied.
 *
 * The upstream adapter uses Slack's `chatStream()` helper without passing
 * `buffer_size`, so the SDK waits for 256 characters before it emits the first
 * `chat.startStream`/`chat.appendStream` call. The upstream stream method also
 * withholds plain single-line text until the markdown renderer decides it has a
 * committable prefix. Junior keeps the upstream table-wrapping setting, lowers
 * the hidden SDK buffer, and eagerly flushes safe plain-text prefixes so Slack
 * threads show visible content sooner.
 */
export function createJuniorSlackAdapter(
  config?: SlackAdapterConfig,
): SlackAdapter {
  const adapter = createSlackAdapter(config);
  const internals = adapter as unknown as SlackAdapterInternals;
  assertSlackAdapterInternals(internals);
  patchSlackClientStream(adapter);
  patchSlackAdapterStream(adapter);
  return adapter;
}
