// The model calls of core. The host builds one client from its credentials
// and model catalog, and passes it to the Turn engine. Each request carries
// its own settings, so one client serves every Turn.
import { performance } from "node:perf_hooks";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type { TurnReasoningLevel } from "@/chat/reasoning-level";
import {
  classifyFailure,
  modelFailureAttributes,
  providerErrorBodySchema,
  retryAfterMs,
  type ModelFailure,
  type RequestObservation,
} from "@/core/model/failure";
import {
  chatEndAttributes,
  chatStartAttributes,
  responseTiming,
} from "@/core/model/span";
import { withSpan, type FailableSpan } from "@/core/telemetry";
import { gatewayRoutingAttributes } from "@/chat/pi/gateway-routing-attributes";
import { requestPrefixAttributes } from "@/chat/pi/request-prefix-attributes";

/** Sends one model request and streams the reply. */
type SendModelRequest = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** The model that a Turn uses, and how its requests are recorded. */
export type ModelSettings = {
  id: string;
  reasoning: TurnReasoningLevel;
  /** `public` records message content on spans. */
  privacy: ConversationPrivacy;
};

/** One model request. */
export type ModelRequest = {
  model: ModelSettings;
  /** Keeps the requests of one Conversation together, for the prompt cache. */
  session: string;
  context: Context;
};

/**
 * The reply to one model request. `failure` is set when the reply's stop
 * reason is `error` or `aborted`.
 */
export type ModelReply = {
  message: AssistantMessage;
  failure?: ModelFailure;
};

/** The model calls that core makes. */
export type ModelClient = {
  /**
   * Makes one model request in a `gen_ai.chat` span. A failed or aborted
   * request returns its reply with its failure. It does not retry.
   */
  complete: (request: ModelRequest, signal: AbortSignal) => Promise<ModelReply>;
};

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

// The body of a response, which records the error when reading it fails,
// such as a connection that closes in the middle of a stream.
function observedBody(
  body: ReadableStream<Uint8Array>,
  observed: RequestObservation,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        observed.transportError = errorName(error);
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

// Records the last response that was not a success, and an error that the
// connection threw. Pi turns both into error text, and gives only a success
// to `onResponse`.
function observingFetch(
  base: typeof fetch,
  observed: RequestObservation,
): typeof fetch {
  return async (input, init) => {
    let response: Response;
    try {
      response = await base(input, init);
    } catch (error) {
      observed.transportError = errorName(error);
      throw error;
    }
    if (response.ok) {
      delete observed.errorResponse;
      return response.body
        ? new Response(observedBody(response.body, observed), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        : response;
    }
    const body = providerErrorBodySchema.safeParse(
      await response
        .clone()
        .json()
        .catch(() => undefined),
    );
    const wait = retryAfterMs(response.headers);
    observed.errorResponse = {
      status: response.status,
      ...(wait !== undefined ? { retryAfterMs: wait } : undefined),
      ...(body.success && body.data.error.type
        ? { errorType: body.data.error.type }
        : undefined),
      ...(body.success && body.data.error.message
        ? { errorMessage: body.data.error.message }
        : undefined),
    };
    return response;
  };
}

// The diagnostics that pi's request hooks give: the cache prefix hashes of
// the request body, the Vercel request id and event loop load when the
// response starts, and how AI Gateway routed the request.
function diagnosticHooks(
  span: FailableSpan,
): Pick<
  SimpleStreamOptions,
  "onPayload" | "onResponse" | "onProviderStreamEvent"
> {
  const eventLoopStart = performance.eventLoopUtilization();
  return {
    onPayload: (payload) => {
      span.setAttributes(requestPrefixAttributes(payload));
      return undefined;
    },
    onResponse: (response) => {
      const vercelId = response.headers["x-vercel-id"];
      if (vercelId) {
        span.setAttribute("app.ai.gateway.vercel_id", vercelId);
      }
      const { utilization } = performance.eventLoopUtilization(eventLoopStart);
      span.setAttribute(
        "app.ai.event_loop.utilization",
        Math.round(utilization * 1000) / 1000,
      );
    },
    onProviderStreamEvent: (event) => {
      const attributes = gatewayRoutingAttributes(event);
      if (attributes) {
        span.setAttributes(attributes);
      }
    },
  };
}

/**
 * Builds the model client. `apiKey` runs before each request, because a
 * credential can rotate between requests. `send` sends the request, such as
 * pi-ai's `streamSimple`. `fetch` is the HTTP client that `send` uses.
 */
export function modelClient(dependencies: {
  apiKey: () => Promise<string>;
  resolveModel: (id: string) => Model<Api>;
  send: SendModelRequest;
  fetch?: typeof fetch;
}): ModelClient {
  return {
    complete: ({ model, session, context }, signal) =>
      withSpan(
        "gen_ai.chat",
        chatStartAttributes({ model, session, context }),
        async (span) => {
          const observed: RequestObservation = {};
          const startedAtMs = Date.now();
          const stream = await dependencies.send(
            dependencies.resolveModel(model.id),
            context,
            {
              apiKey: await dependencies.apiKey(),
              sessionId: session,
              // Pi takes no reasoning level to mean none.
              reasoning:
                model.reasoning === "none" ? undefined : model.reasoning,
              signal,
              fetch: observingFetch(
                dependencies.fetch ?? globalThis.fetch,
                observed,
              ),
              ...diagnosticHooks(span),
            },
          );
          const timing = responseTiming(startedAtMs);
          for await (const event of stream) {
            timing.observe(event);
          }
          const message = await stream.result();
          const failure =
            message.stopReason === "error" || message.stopReason === "aborted"
              ? classifyFailure(observed, message)
              : undefined;
          span.setAttributes({
            ...chatEndAttributes(message, model.privacy),
            ...timing.attributes(),
            ...(failure
              ? {
                  ...modelFailureAttributes(failure),
                  "error.type": failure.kind,
                }
              : undefined),
          });
          if (failure) {
            span.fail(failure.message);
          }
          return failure ? { message, failure } : { message };
        },
        { spanName: `chat ${model.id}` },
      ),
  };
}
