import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";

/** One fixed model output for one model request. */
export type FixedModelOutput =
  | {
      type: "text";
      text: string;
      onRequest?: () => void;
      waitFor?: Promise<unknown> | "abort";
      /** Stop waiting for the abort after this time, as a run that ignores it. */
      abortTimeoutMs?: number;
    }
  | {
      type: "toolCall";
      name: string;
      arguments: Parameters<typeof fauxToolCall>[1];
      onRequest?: () => void;
      waitFor?: Promise<unknown>;
    }
  | {
      type: "error";
      errorMessage: string;
      onRequest?: () => void;
      waitFor?: Promise<unknown>;
    }
  | {
      type: "message";
      message: AssistantMessage;
      onRequest?: () => void;
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
  const abortTimeoutMs =
    output.type === "text" ? output.abortTimeoutMs : undefined;
  if (!onRequest && !waitFor) {
    return message;
  }
  return async (_context, options) => {
    onRequest?.();
    if (waitFor === "abort") {
      const signal = options?.signal;
      if (!signal) {
        throw new Error("Waiting for abort requires a model request signal");
      }
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
          if (abortTimeoutMs !== undefined) {
            setTimeout(resolve, abortTimeoutMs);
          }
        });
      }
    } else if (waitFor) {
      await waitFor;
    }
    return message;
  };
}

/** Set the model output returned for each model request. */
export function createModelStream(outputs: FixedModelOutput[]): StreamFn {
  const faux = createFauxCore({ api: "test", provider: "test" });
  faux.setResponses(outputs.map(createResponseStep));
  return faux.stream;
}
