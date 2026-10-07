/**
 * The recording files of the recording proxy.
 *
 * A recording is one JSON file, `<directory>/<rule>/<key>.json`. It keeps
 * the response of one request, the test (session) that recorded it, and a
 * short hash of each part of the request (`request-parts.ts`). It does not
 * keep the request body, so prompts and other inputs are not committed.
 *
 * Like the server, this file uses only Node built-ins.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closestRequest, type RequestParts } from "./request-parts.ts";

/** One recorded response. */
export interface Recording {
  writtenAt: string;
  /** The session (test) that recorded the response. */
  session?: string;
  request: { method: string; url: string; parts?: RequestParts };
  response: {
    body: string;
    /** `base64` for a body that is not text, such as an image. */
    bodyEncoding: "base64" | "utf8";
    headers: Record<string, string>;
    status: number;
    statusText: string;
  };
}

/** Read a recording. Returns `undefined` when there is none. */
export async function readRecording(
  file: string,
): Promise<Recording | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Recording;
  } catch {
    return undefined;
  }
}

/** Write recordings. Returns how many were new or changed. */
export async function saveRecordings(
  recordings: Iterable<[string, Recording]>,
): Promise<number> {
  const changed = await Promise.all(
    [...recordings].map(async ([file, recording]) => {
      const content = `${JSON.stringify(recording, null, 2)}\n`;
      const previous = await readFile(file, "utf8").catch(() => undefined);
      if (previous === content) return false;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      return true;
    }),
  );
  return changed.filter(Boolean).length;
}

interface IndexEntry {
  file: string;
  session?: string;
  parts: RequestParts;
}

/**
 * The request parts of the recordings in one rule directory, for miss
 * diagnosis. It reads the directory on first use.
 */
export function createRecordingIndex(directory: string) {
  let entries: Promise<Map<string, IndexEntry>> | undefined;
  const load = async () => {
    const result = new Map<string, IndexEntry>();
    const names = await readdir(directory).catch(() => [] as string[]);
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const file = path.join(directory, name);
      const recording = await readRecording(file);
      if (recording?.request.parts) {
        result.set(file, {
          file,
          session: recording.session,
          parts: recording.request.parts,
        });
      }
    }
    return result;
  };
  const all = () => (entries ??= load());

  return {
    /** Add or replace a recording that the proxy wrote. */
    async add(file: string, recording: Recording) {
      if (!entries || !recording.request.parts) return;
      (await entries).set(file, {
        file,
        session: recording.session,
        parts: recording.request.parts,
      });
    },
    /**
     * The recording with the most equal parts, and the parts that differ.
     * Recordings of the same session come first, because a test usually
     * sends the same requests as the last time it ran.
     */
    async closest(parts: RequestParts, session: string | undefined) {
      const candidates = [...(await all()).values()];
      const same = candidates.filter((entry) => entry.session === session);
      return closestRequest(
        parts,
        session !== undefined && same.length > 0 ? same : candidates,
      );
    },
  };
}

/**
 * Delete the recordings in `directory` that no used file lists. Each used
 * file comes from `usedFile` of one proxy run. Returns how many it deleted.
 * Give it the used files of every run that shares the directory, or it
 * deletes recordings that another run needs.
 */
export async function pruneRecordings(
  directory: string,
  usedFiles: string[],
): Promise<number> {
  const used = new Set<string>();
  for (const file of usedFiles) {
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      if (line) used.add(line);
    }
  }
  const recordings = (await readdir(directory, { recursive: true })).filter(
    (file) => file.endsWith(".json"),
  );
  const unused = recordings.filter((file) => !used.has(file));
  await Promise.all(unused.map((file) => rm(path.join(directory, file))));
  return unused.length;
}
