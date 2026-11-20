import {
  normalizeContext,
  type AssistantMessage,
  type Context,
  type SimpleStreamOptions,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentRequestStreamFn } from "@/chat/pi/agent-history";
import type { ModelClient } from "@/core/model/client";

type ModelToolCall = {
  name: string;
  arguments: Parameters<typeof fauxToolCall>[1];
  id?: string;
};

type FixedModelOutput =
  | {
      type: "text";
      text: string;
      /** `length`: the reply hit the output token limit. */
      stopReason?: "length";
      onRequest?: (context: Context) => void;
      waitFor?: Promise<unknown> | "abort";
    }
  | {
      type: "toolCall";
      name: string;
      arguments: Parameters<typeof fauxToolCall>[1];
      onRequest?: (context: Context) => void;
      waitFor?: Promise<unknown>;
    }
  | {
      type: "toolCalls";
      calls: ModelToolCall[];
      /** `length`: the reply hit the output token limit. */
      stopReason?: "length";
      onRequest?: (context: Context) => void;
      waitFor?: Promise<unknown>;
    }
  | {
      type: "error";
      errorMessage: string;
      /** `aborted`: the request ended because its signal aborted. */
      stopReason?: "aborted";
      onRequest?: (context: Context) => void;
      waitFor?: Promise<unknown>;
    }
  | {
      type: "message";
      message: AssistantMessage;
      onRequest?: (context: Context) => void;
      waitFor?: Promise<unknown>;
    };

/** Build the reply that a model output stands for, such as a stored reply in history. */
export function createAssistantMessage(
  output: FixedModelOutput,
): AssistantMessage {
  if (output.type === "text") {
    return fauxAssistantMessage(output.text, { stopReason: output.stopReason });
  }
  if (output.type === "toolCall") {
    return createAssistantMessage({ type: "toolCalls", calls: [output] });
  }
  if (output.type === "toolCalls") {
    return fauxAssistantMessage(
      output.calls.map((call) =>
        fauxToolCall(call.name, call.arguments, { id: call.id }),
      ),
      { stopReason: output.stopReason ?? "toolUse" },
    );
  }
  if (output.type === "error") {
    return fauxAssistantMessage("", {
      stopReason: output.stopReason ?? "error",
      errorMessage: output.errorMessage,
    });
  }
  return output.message;
}

/** Wait the way the output asks for, then give its reply. */
async function respond(
  output: FixedModelOutput,
  message: AssistantMessage,
  context: Context,
  signal: AbortSignal | undefined,
): Promise<AssistantMessage> {
  output.onRequest?.(context);
  if (output.waitFor === "abort") {
    if (!signal) {
      throw new Error("Waiting for abort requires a model request signal");
    }
    if (!signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  } else if (output.waitFor) {
    await output.waitFor;
  }
  return message;
}

function createResponseStep(output: FixedModelOutput): FauxResponseStep {
  const message = createAssistantMessage(output);
  if (!output.onRequest && !output.waitFor) {
    return message;
  }
  return (context, options) =>
    respond(output, message, context, options?.signal);
}

/** Call a provider stream the way pi-ai's `streamSimple` calls one. */
export function fauxRequestStream(
  stream: StreamFunction<string, SimpleStreamOptions>,
): AgentRequestStreamFn {
  return (model, context, options) =>
    stream(model, normalizeContext(context), options);
}

/** Set the model output returned for each model request. */
export function createModelStream(
  outputs: FixedModelOutput[],
): AgentRequestStreamFn {
  const faux = createFauxCore({ api: "test", provider: "test" });
  faux.setResponses(outputs.map(createResponseStep));
  return fauxRequestStream(faux.stream);
}

/**
 * A model client that returns the model output for each request in order.
 * Core steps take it in place of the real client.
 */
export function fakeModelClient(outputs: FixedModelOutput[]): ModelClient {
  const responses = outputs.map((output) => ({
    output,
    message: createAssistantMessage(output),
  }));
  return {
    complete: (request, signal) => {
      const next = responses.shift();
      if (!next) {
        return Promise.reject(
          new Error("No model output is left for this request"),
        );
      }
      return respond(next.output, next.message, request.context, signal);
    },
  };
}
