import * as Sentry from "@/chat/sentry";
import { getCurrentConversationPrivacy } from "@/chat/conversation-privacy";
import {
  getLogContextAttributesForSpan,
  setSpanAttributes,
} from "@/chat/logging";

type SpanAttributes = Record<string, unknown>;

// The `sentry.origin` of the spans that the SDK's `vercelAIIntegration` starts
// around each `ai` call.
const VERCEL_AI_SPAN_ORIGIN = "auto.ai.vercelai";

function setVercelAiSpanAttributes(attributes: SpanAttributes): void {
  const span = Sentry.getActiveSpan();
  if (
    span &&
    Sentry.spanToJSON(span).attributes?.["sentry.origin"] ===
      VERCEL_AI_SPAN_ORIGIN
  ) {
    setSpanAttributes(attributes);
  }
}

/**
 * Build the `onStart` and `onEnd` callbacks of one `ai` call. They add Junior
 * attributes to the span that the SDK's `vercelAIIntegration` starts for the
 * call. `ai` runs both callbacks inside that span, before it ends.
 */
export function aiSdkSpanCallbacks<TEndEvent>(params: {
  attributes: SpanAttributes;
  endAttributes?: (event: TEndEvent) => SpanAttributes | undefined;
}): { onStart: () => void; onEnd: (event: TEndEvent) => void } {
  return {
    onStart: () =>
      setVercelAiSpanAttributes({
        ...getLogContextAttributesForSpan("gen_ai.chat"),
        "app.conversation.privacy":
          getCurrentConversationPrivacy() ?? "private",
        ...params.attributes,
      }),
    onEnd: (event) => {
      const attributes = params.endAttributes?.(event);
      if (attributes) {
        setVercelAiSpanAttributes(attributes);
      }
    },
  };
}
