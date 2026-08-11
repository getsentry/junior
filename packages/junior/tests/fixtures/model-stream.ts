import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";

type FixedModelOutput =
  | {
      type: "text";
      text: string;
      waitFor?: Promise<unknown>;
    }
  | {
      type: "toolCall";
      name: string;
      arguments: Parameters<typeof fauxToolCall>[1];
      waitFor?: Promise<unknown>;
    }
  | {
      type: "error";
      errorMessage: string;
      waitFor?: Promise<unknown>;
    }
  | {
      type: "message";
      message: AssistantMessage;
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
  const { waitFor } = output;
  if (!waitFor) {
    return message;
  }
  return async () => {
    await waitFor;
    return message;
  };
}

/** Set the model output returned for each model request. */
export function createModelStream(outputs: FixedModelOutput[]): StreamFn {
  const faux = createFauxCore({ api: "test", provider: "test" });
  faux.setResponses(outputs.map(createResponseStep));
  return faux.stream;
}
