import { createGatewayProvider } from "@ai-sdk/gateway";
import { transcribe } from "ai";
import * as z from "zod";
import {
  extractGenAiUsageAttributes,
  logException,
  withSpan,
} from "@/chat/logging";
import {
  gatewayCostUsd,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_SERVER_ADDRESS,
  GEN_AI_SERVER_PORT,
  resolveGatewayCredential,
} from "@/chat/pi/client";
import {
  createProviderError,
  isProviderRetryError,
  ProviderError,
} from "@/chat/services/provider-error";

const GEN_AI_OPERATION_TRANSCRIPTION = "transcription" as const;
// ElevenLabs puts its error code at the end of the message, such as
// "File is corrupted. Please ensure it is playable audio. (invalid_audio)".
// It returns this code for a video with no audio track and for a file that
// is not media.
const NO_AUDIO_PATTERN = /\(invalid_audio\)\s*$/;
// A sentence end, so a long turn of one speaker still has timestamps.
const SENTENCE_END_PATTERN = /[.?!]["')\]]*$/;

/** The file has no audio that the model can transcribe. */
export class NoAudioError extends Error {
  override readonly name = "NoAudioError";
}

/** One stretch of speech by one speaker. */
export interface TranscriptSegment {
  endSeconds: number;
  speaker?: string;
  startSeconds: number;
  text: string;
}

/** Text and timing of the speech in one audio or video file. */
export interface Transcript {
  costUsd?: number;
  durationSeconds?: number;
  language?: string;
  segments: TranscriptSegment[];
  text: string;
}

// ElevenLabs Scribe returns each word, space, and audio event with its
// speaker when `diarize` is set.
const diarizedWordsSchema = z.object({
  elevenlabs: z.object({
    words: z.array(
      z.object({
        end: z.number(),
        speaker_id: z.string().nullish(),
        start: z.number(),
        text: z.string(),
        type: z.string(),
      }),
    ),
  }),
});

/**
 * Group diarized words into segments. A segment ends when the speaker
 * changes or a sentence ends. Spaces join words and never start a segment.
 */
function speakerSegments(
  words: z.infer<typeof diarizedWordsSchema>["elevenlabs"]["words"],
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let current: TranscriptSegment | undefined;
  for (const word of words) {
    if (word.type === "spacing") {
      if (current) current.text += word.text;
      continue;
    }
    const speaker = word.speaker_id ?? undefined;
    if (!current || current.speaker !== speaker) {
      current = {
        endSeconds: word.end,
        startSeconds: word.start,
        text: "",
        ...(speaker ? { speaker } : undefined),
      };
      segments.push(current);
    }
    current.text += word.text;
    current.endSeconds = word.end;
    if (SENTENCE_END_PATTERN.test(word.text)) current = undefined;
  }
  return segments
    .map((segment) => ({ ...segment, text: segment.text.trim() }))
    .filter((segment) => segment.text.length > 0);
}

/**
 * Keep the classification of a failed call, but not the SDK error. That
 * error keeps the request body, and the body holds the signed URL.
 */
function withoutSourceUrl(
  error: unknown,
  sourceUrl: string,
  modelId: string,
): ProviderError {
  const failure = error instanceof Error ? error : undefined;
  const message = (failure?.message ?? String(error)).replaceAll(
    sourceUrl,
    "<signed URL>",
  );
  // Classify the redacted message. The URL path holds the storage key, and a
  // key can match a provider pattern such as "timeout" or "forbidden".
  // The cause keeps transport codes such as ECONNRESET.
  const classified = createProviderError(
    Object.assign(new Error(message, { cause: failure?.cause }), {
      code: failure && "code" in failure ? failure.code : undefined,
      statusCode:
        failure && "statusCode" in failure ? failure.statusCode : undefined,
    }),
    { modelId },
  );
  return new ProviderError({
    cause: new Error(message),
    kind: classified.kind,
    modelId,
    retryable: classified.retryable,
    retryAfterMs: classified.retryAfterMs,
    status: classified.status,
  });
}

/**
 * Transcribe speech in a file that the provider downloads from `sourceUrl`.
 *
 * The URL goes to the provider as `sourceUrl` with empty audio, so the file
 * never passes through this process. The URL is a bearer credential: it is
 * not put on spans, logs, or errors.
 */
export async function transcribeFromUrl(params: {
  conversationId?: string;
  modelId: string;
  signal?: AbortSignal | undefined;
  sourceUrl: string;
}): Promise<Transcript> {
  const credential = await resolveGatewayCredential();
  const provider = createGatewayProvider({ apiKey: credential.token });
  try {
    return await withSpan(
      `${GEN_AI_OPERATION_TRANSCRIPTION} ${params.modelId}`,
      "gen_ai.transcription",
      {
        modelId: params.modelId,
        ...(params.conversationId
          ? { conversationId: params.conversationId }
          : undefined),
      },
      async (setSpanAttributes) => {
        const result = await transcribe({
          model: provider.transcriptionModel(params.modelId),
          // A URL here makes the SDK download the file in this process.
          audio: new Uint8Array(),
          providerOptions: {
            elevenlabs: {
              diarize: true,
              sourceUrl: params.sourceUrl,
              tagAudioEvents: true,
            },
          },
          ...(params.signal ? { abortSignal: params.signal } : undefined),
        }).catch((error: unknown) => {
          if (error instanceof Error && NO_AUDIO_PATTERN.test(error.message)) {
            setSpanAttributes({ "error.type": "invalid_audio" });
            throw new NoAudioError("The file has no audio to transcribe.");
          }
          throw error;
        });
        const costUsd = gatewayCostUsd(result.providerMetadata);
        const generationId =
          result.providerMetadata["gateway"]?.["generationId"];
        const words = diarizedWordsSchema.safeParse(result.providerMetadata);
        const segments = words.success
          ? speakerSegments(words.data.elevenlabs.words)
          : result.segments.map((segment) => ({
              endSeconds: segment.endSecond,
              startSeconds: segment.startSecond,
              text: segment.text,
            }));
        setSpanAttributes({
          ...(typeof generationId === "string"
            ? { "gen_ai.response.id": generationId }
            : undefined),
          ...(result.durationInSeconds !== undefined
            ? { "app.transcription.audio_seconds": result.durationInSeconds }
            : undefined),
          "app.transcription.segment_count": segments.length,
          ...extractGenAiUsageAttributes(
            costUsd !== undefined ? { cost: { total: costUsd } } : undefined,
          ),
        });
        return {
          ...(costUsd !== undefined ? { costUsd } : undefined),
          ...(result.durationInSeconds !== undefined
            ? { durationSeconds: result.durationInSeconds }
            : undefined),
          ...(result.language ? { language: result.language } : undefined),
          segments,
          text: result.text,
        };
      },
      {
        "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
        "gen_ai.operation.name": GEN_AI_OPERATION_TRANSCRIPTION,
        "gen_ai.request.model": params.modelId,
        "server.address": GEN_AI_SERVER_ADDRESS,
        "server.port": GEN_AI_SERVER_PORT,
        "gen_ai.provider.auth_mode": credential.mode,
      },
    );
  } catch (error) {
    if (error instanceof NoAudioError) throw error;
    const providerError = withoutSourceUrl(
      error,
      params.sourceUrl,
      params.modelId,
    );
    if (isProviderRetryError(providerError)) {
      throw providerError;
    }

    logException(providerError, "ai.transcription.failed", {
      "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
      "gen_ai.operation.name": GEN_AI_OPERATION_TRANSCRIPTION,
      "gen_ai.request.model": params.modelId,
    });
    throw providerError;
  }
}
