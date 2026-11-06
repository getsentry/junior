import { transcriptionSchema } from "@sentry/junior/api/schema";
import { useEffect, useRef, useState } from "react";
import { DashboardApiError, postBlob } from "../http";

/** Longest dictation. Keeps the upload under the transcription body limit. */
export const DICTATION_MAX_SECONDS = 120;

// Opus is small and widely supported. Safari records only AAC in MP4.
const RECORDING_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

/** Where one dictation is: asking for the mic, recording, or transcribing. */
export type DictationState = "idle" | "starting" | "recording" | "transcribing";

type DictationSession = {
  abort: AbortController;
  cancelled: boolean;
  recorder?: MediaRecorder;
  stream?: MediaStream;
  timer?: number;
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

/** Record one clip from the microphone and turn it into text. */
export function useDictation(callbacks: DictationCallbacks) {
  const [state, setState] = useState<DictationState>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
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
      const { text } = await postBlob(
        transcriptionSchema,
        "/api/transcriptions",
        audio,
        session.abort.signal,
      );
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
    const session: DictationSession = {
      abort: new AbortController(),
      cancelled: false,
    };
    sessionRef.current = session;
    callbacksRef.current.onError(undefined);
    setElapsedSeconds(0);
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
    const mimeType = RECORDING_TYPES.find((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    const recorder = new MediaRecorder(
      session.stream,
      mimeType ? { mimeType } : undefined,
    );
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
    const startedAt = Date.now();
    session.timer = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      setElapsedSeconds(seconds);
      if (seconds >= DICTATION_MAX_SECONDS) stop();
    }, 1000);
    recorder.start();
    setState("recording");
  };

  const cancel = () => {
    const session = sessionRef.current;
    if (!session) return;
    session.cancelled = true;
    session.abort.abort();
    if (session.recorder?.state === "recording") session.recorder.stop();
    else releaseMicrophone(session);
    finish(session);
  };

  // Leaving the page must turn the microphone off.
  useEffect(
    () => () => {
      const session = sessionRef.current;
      if (!session) return;
      session.cancelled = true;
      session.abort.abort();
      if (session.recorder?.state === "recording") session.recorder.stop();
      releaseMicrophone(session);
    },
    [],
  );

  return { cancel, elapsedSeconds, start, state, stop };
}

function releaseMicrophone(session: DictationSession): void {
  window.clearInterval(session.timer);
  for (const track of session.stream?.getTracks() ?? []) track.stop();
}

function microphoneErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : undefined;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Allow microphone access in your browser to dictate.";
  }
  if (name === "NotFoundError") return "No microphone found.";
  return "Could not start the microphone.";
}
