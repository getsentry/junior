import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { botConfig } from "../../chat/config";
import { transcribeAudio } from "../../chat/pi/client";
import {
  findProviderError,
  getProviderErrorUserMessage,
} from "../../chat/services/provider-error";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  transcriptionRequestSchema,
  transcriptionSchema,
} from "../schema/transcription";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";

/** Create the route that turns one dashboard dictation recording into text. */
export function createTranscriptionRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.post(
    "/",
    requireViewer,
    bodyLimit({
      maxSize: 4_450_000,
      onError: () => {
        throwApiError(413, "Recording is too long.");
      },
    }),
    validateRequest(
      "json",
      transcriptionRequestSchema,
      "Send the recording as base64 audio.",
    ),
    async (context) => {
      const audio = Buffer.from(context.req.valid("json").audio, "base64");
      try {
        const { text } = await transcribeAudio({
          audio,
          modelId: botConfig.transcriptionModelId,
          signal: context.req.raw.signal,
        });
        return jsonResponse(transcriptionSchema, { text: text.trim() });
      } catch (error) {
        // `transcribeAudio` already logged the provider failure. Tell the
        // viewer why instead of a bare 500.
        const providerError = findProviderError(error);
        if (!providerError) throw error;
        throwApiError(
          502,
          getProviderErrorUserMessage(providerError),
          providerError,
        );
      }
    },
  );

  return app;
}
