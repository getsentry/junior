import { base64DataSchema } from "@/chat/attachments/input";
import * as z from "zod";

/** Largest dictation recording the API accepts. Base64 in JSON keeps the request under the hosting platform limit. */
export const MAX_TRANSCRIPTION_AUDIO_BYTES = 3 * 1024 * 1024;

/** One dictation recording. The model reads the audio format from the bytes. */
export const transcriptionRequestSchema = z
  .object({ audio: base64DataSchema(MAX_TRANSCRIPTION_AUDIO_BYTES) })
  .strict();

/** Text transcribed from one dictation recording. */
export const transcriptionSchema = z.object({ text: z.string() }).strict();
