import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { botConfig } from "../../chat/config";
import { transcribeAudio } from "../../chat/pi/client";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  transcriptionSchema,
} from "../schema/transcription";
import { requireViewer } from "../viewer";

/** Create the route that turns one dashboard dictation recording into text. */
export function createTranscriptionRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.post(
    "/",
    requireViewer,
    bodyLimit({
      maxSize: MAX_TRANSCRIPTION_AUDIO_BYTES,
      onError: () => {
        throwApiError(413, "Recording is too long.");
      },
    }),
    async (context) => {
      const contentType = context.req.header("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("audio/")) {
        throwApiError(415, "Send the recording as audio.");
      }
      const audio = new Uint8Array(await context.req.arrayBuffer());
      if (!audio.byteLength) throwApiError(400, "Recording is empty.");
      const { text } = await transcribeAudio({
        audio,
        modelId: botConfig.transcriptionModelId,
        signal: context.req.raw.signal,
      });
      return jsonResponse(transcriptionSchema, { text: text.trim() });
    },
  );

  return app;
}
