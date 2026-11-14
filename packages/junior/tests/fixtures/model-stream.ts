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

type FixedModelOutput =
  | {
      type: "text";
      text: string;
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
      type: "error";
      errorMessage: string;
      onRequest?: (context: Context) => void;
      waitFor?: Promise<unknown>;
    }
  | {
      type: "message";
      message: AssistantMessage;
      onRequest?: (context: Context) => void;
      waitFor?: Promise<unknown>;
    };

function createAssistantMessage(output: FixedModelOutput): AssistantMessage {
  if (output.type === "text") {
    return fauxAssistantMessage(output.text);
  }
  if (output.type === "toolCall") {
    return fauxAssistantMessage([fauxToolCall(output.name, output.arguments)], {
      stopReason: "toolUse",
    });
  }
  if (output.type === "error") {
    return fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: output.errorMessage,
    });
  }
  return output.message;
}

function createResponseStep(output: FixedModelOutput): FauxResponseStep {
  const message = createAssistantMessage(output);
  const { onRequest, waitFor } = output;
  if (!onRequest && !waitFor) {
    return message;
  }
  return async (context, options) => {
    onRequest?.(context);
    if (waitFor === "abort") {
      const signal = options?.signal;
      if (!signal) {
        throw new Error("Waiting for abort requires a model request signal");
      }
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    } else if (waitFor) {
      await waitFor;
    }
    return message;
  };
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
