import { transcriptionSchema } from "@sentry/junior/api/schema";
import { useEffect, useRef, useState } from "react";
import { DashboardApiError, post } from "../http";

/** Longest dictation. Keeps the upload under the transcription body limit. */
export const DICTATION_MAX_SECONDS = 120;

// Opus is small and widely supported. Safari records only AAC in MP4.
const RECORDING_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

// Browsers default to about 128 kbps. Speech needs much less, and a fixed
// rate keeps 2 minutes near 1 MB in every browser, under the upload limit.
const RECORDING_BITS_PER_SECOND = 64_000;

// Where one dictation is: asking for the mic, recording, or transcribing.
type DictationState = "idle" | "starting" | "recording" | "transcribing";

type DictationSession = {
  cancelled: boolean;
  recorder?: MediaRecorder;
  stream?: MediaStream;
  timeout?: number;
};

type DictationCallbacks = {
  onError(message: string | undefined): void;
  onText(text: string): void;
};

/** True when this browser can record microphone audio. */
export function dictationSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

/** Controls for one composer's dictation. */
export type Dictation = {
  cancel(): void;
  start(): Promise<void>;
  state: DictationState;
  stop(): void;
};

/** Record one clip from the microphone and turn it into text. */
export function useDictation(callbacks: DictationCallbacks): Dictation {
  const [state, setState] = useState<DictationState>("idle");
  const sessionRef = useRef<DictationSession | undefined>(undefined);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const finish = (session: DictationSession) => {
    if (sessionRef.current !== session) return;
    sessionRef.current = undefined;
    setState("idle");
  };

  const stop = () => {
    const recorder = sessionRef.current?.recorder;
    if (recorder?.state === "recording") recorder.stop();
  };

  const transcribe = async (session: DictationSession, audio: Blob) => {
    setState("transcribing");
    try {
      const { text } = await post(transcriptionSchema, "/api/transcriptions", {
        audio: await readBase64(audio),
      });
      if (session.cancelled) return;
      if (text) callbacksRef.current.onText(text);
      else callbacksRef.current.onError("No speech heard. Try again.");
    } catch (error) {
      if (session.cancelled) return;
      callbacksRef.current.onError(
        error instanceof DashboardApiError && error.apiError
          ? error.apiError
          : "Could not transcribe the recording. Try again.",
      );
    } finally {
      finish(session);
    }
  };

  const start = async () => {
    if (sessionRef.current) return;
    const session: DictationSession = { cancelled: false };
    sessionRef.current = session;
    callbacksRef.current.onError(undefined);
    setState("starting");
    try {
      session.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      finish(session);
      if (!session.cancelled) {
        callbacksRef.current.onError(microphoneErrorMessage(error));
      }
      return;
    }
    if (session.cancelled) {
      releaseMicrophone(session);
      return;
    }
    // Recorder setup can throw, such as for an unsupported device. Turn the
    // mic off so it does not stay live.
    try {
      const mimeType = RECORDING_TYPES.find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      const recorder = new MediaRecorder(session.stream, {
        audioBitsPerSecond: RECORDING_BITS_PER_SECOND,
        ...(mimeType ? { mimeType } : undefined),
      });
      const chunks: Blob[] = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size) chunks.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        releaseMicrophone(session);
        if (session.cancelled) return;
        const audio = new Blob(chunks, {
          type: recorder.mimeType || mimeType || "audio/webm",
        });
        if (!audio.size) {
          callbacksRef.current.onError("No audio recorded. Try again.");
          finish(session);
          return;
        }
        void transcribe(session, audio);
      });
      session.recorder = recorder;
      session.timeout = window.setTimeout(stop, DICTATION_MAX_SECONDS * 1000);
      recorder.start();
    } catch {
      releaseMicrophone(session);
      finish(session);
      callbacksRef.current.onError("Could not start recording.");
      return;
    }
    setState("recording");
  };

  const cancel = () => {
    const session = sessionRef.current;
    if (!session) return;
    abandon(session);
    finish(session);
  };

  // Leaving the page must turn the microphone off.
  useEffect(
    () => () => {
      if (sessionRef.current) abandon(sessionRef.current);
    },
    [],
  );

  return { cancel, start, state, stop };
}

// Drop the clip and any text still on its way, and turn the mic off.
function abandon(session: DictationSession): void {
  session.cancelled = true;
  if (session.recorder?.state === "recording") session.recorder.stop();
  releaseMicrophone(session);
}

function releaseMicrophone(session: DictationSession): void {
  window.clearTimeout(session.timeout);
  for (const track of session.stream?.getTracks() ?? []) track.stop();
}

function readBase64(audio: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]!);
    reader.readAsDataURL(audio);
  });
}

function microphoneErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : undefined;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Allow microphone access in your browser to dictate.";
  }
  if (name === "NotFoundError") return "No microphone found.";
  return "Could not start the microphone.";
}
