/**
 * The recording files of Roach.
 *
 * A recording is one JSON file, `<directory>/<rule>/<key>.json`. It keeps
 * the response of one request, the session (test) that recorded it, and
 * the parts of the request (`request-key.ts`). It does not keep the request
 * body, so prompts and other inputs are not committed.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closestRequest, type RequestParts } from "./request-key.ts";

/** One recorded response. */
export interface Recording {
  /** The session (test) that recorded the response. */
  session?: string;
  request: { method: string; url: string; parts: RequestParts };
  response: {
    status: number;
    headers: Record<string, string>;
    /**
     * A text body keeps each changing value of its request as a
     * placeholder (`values.ts`).
     */
    body: string;
    /** `base64` for a body that is not text, such as an image. */
    bodyEncoding: "base64" | "utf8";
  };
}

const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

/** Read a recording. Returns `undefined` when there is none. */
export async function readRecording(
  file: string,
): Promise<Recording | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Recording;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** Write recordings. Returns how many were new or changed. */
export async function writeRecordings(
  recordings: Iterable<[string, Recording]>,
): Promise<number> {
  const changed = await Promise.all(
    [...recordings].map(async ([file, recording]) => {
      const content = `${JSON.stringify(recording, null, 2)}\n`;
      const previous = await readFile(file, "utf8").catch((error) => {
        if (isMissing(error)) return undefined;
        throw error;
      });
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

/** The recordings of one rule, for miss diagnosis. */
export interface RecordingIndex {
  /** Add or replace a recording that the proxy wrote. */
  add(file: string, recording: Recording): void;
  /**
   * The recording with the most equal parts, and the parts that differ.
   * Recordings of the same session come first, because a test usually
   * sends the same requests as the last time it ran.
   */
  closest(
    parts: RequestParts,
    session: string | undefined,
  ): Promise<{ file: string; differs: string[] } | undefined>;
  /** The recordings that the session `session` recorded. */
  filesOf(session: string): Promise<string[]>;
}

/** Index the recordings of one rule directory. It reads them on first use. */
export function createRecordingIndex(directory: string): RecordingIndex {
  const entries = new Map<string, IndexEntry>();
  let loaded: Promise<void> | undefined;
  const entryOf = (file: string, recording: Recording): IndexEntry => ({
    file,
    session: recording.session,
    parts: recording.request.parts,
  });
  const load = async () => {
    const names = await readdir(directory).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const file = path.join(directory, name);
      const recording = await readRecording(file);
      if (recording && !entries.has(file)) {
        entries.set(file, entryOf(file, recording));
      }
    }
  };

  return {
    add(file, recording) {
      entries.set(file, entryOf(file, recording));
    },
    async closest(parts, session) {
      await (loaded ??= load());
      const all = [...entries.values()];
      const same = all.filter((entry) => entry.session === session);
      const found = closestRequest(
        parts,
        session !== undefined && same.length > 0 ? same : all,
      );
      return found && { file: found.candidate.file, differs: found.differs };
    },
    async filesOf(session) {
      await (loaded ??= load());
      return [...entries.values()]
        .filter((entry) => entry.session === session)
        .map((entry) => entry.file);
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
