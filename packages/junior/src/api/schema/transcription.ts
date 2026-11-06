import * as z from "zod";

/** Largest dictation recording the API accepts. About 2 minutes of Opus or AAC. */
export const MAX_TRANSCRIPTION_AUDIO_BYTES = 4_000_000;

/** Text transcribed from one dictation recording. */
export const transcriptionSchema = z.object({ text: z.string() }).strict();
