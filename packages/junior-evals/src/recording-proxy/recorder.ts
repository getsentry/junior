/**
 * The recording logic of the proxy: modes, sessions, replay, and misses.
 *
 * `server.ts` owns the sockets. It gives the recorder each request that a
 * rule matches, with a function that sends the request live. The recorder
 * decides whether to replay, send live, or fail the request, and it owns
 * every read and write of the recordings.
 *
 * A session groups the requests of one test. One session is open at a
 * time. The recorder keeps the new recordings of a session in memory until
 * the session ends. A passed session writes them, and a failed session
 * drops them, so a bad sample is never replayed. A request that ends after
 * its session ended follows the result of that session. A request outside
 * a session is written at once.
 */
import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import path from "node:path";
import {
  createRecordingIndex,
  readRecording,
  writeRecordings,
  type Recording,
} from "./recordings.ts";
import { describeParts, keyRequest, type KeyedRequest } from "./request-key.ts";
import {
  isEventStream,
  mapStreamEvents,
  mergeStreamDeltas,
} from "./streams.ts";
import type {
  RecordingMiss,
  RecordingProxyConfig,
  RecordingRule,
  RecordingStats,
} from "./types.ts";
import { fillValues, templateValues, type RequestValues } from "./values.ts";

/** A request with its whole body. */
export interface ProxyRequest {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** A response with its whole body. */
export interface ProxyResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** Where the response to a recorded request came from. */
export type ResponseSource = "live" | "missed" | "replayed";

interface Session {
  name: string;
  /** New recordings, by file. */
  recorded: Map<string, Recording>;
  /** Files that the session replayed. They stay used if it fails. */
  replayed: Set<string>;
  /** Requests that `replay` mode failed. */
  missed: number;
  /**
   * Changing values of the requests so far, with their names. A later
   * request can repeat one where no pattern finds it (`values.ts`).
   */
  known: Map<string, string>;
  /** Set when the session ends. */
  passed?: boolean;
}

const MAX_MISSES = 500;
/** Response headers that a recording keeps. Other headers change each run. */
const RECORDED_HEADERS = ["content-type", "location"];
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** Statuses that are never recorded, because they are temporary. */
const isTemporaryStatus = (status: number) => status === 429 || status >= 500;

function matches(
  { match }: RecordingRule,
  { method, url, headers }: ProxyRequest,
): boolean {
  if (match.method && match.method !== method) return false;
  if (match.url && !url.href.startsWith(match.url)) return false;
  return Object.entries(match.headers ?? {}).every(
    ([name, value]) => headers[name] === value,
  );
}

/**
 * The response as a recording keeps it. A stream gets one delta per content
 * block, and each value of the request becomes a placeholder.
 */
function toRecording(
  request: ProxyRequest,
  keyed: KeyedRequest,
  session: string | undefined,
  response: ProxyResponse,
): Recording {
  const contentType = response.headers["content-type"];
  const headers: Record<string, string> = {};
  for (const name of RECORDED_HEADERS) {
    const value = response.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  let body = response.body.toString("base64");
  let bodyEncoding: Recording["response"]["bodyEncoding"] = "base64";
  if (/^text\/|json|xml/i.test(contentType ?? "")) {
    const text = response.body.toString("utf8");
    const template = (part: string) => templateValues(part, keyed.values);
    body = isEventStream(contentType)
      ? mapStreamEvents(mergeStreamDeltas(text), template)
      : template(text);
    bodyEncoding = "utf8";
  }
  return {
    session,
    request: {
      method: request.method,
      url: request.url.href,
      parts: keyed.parts,
    },
    response: { status: response.status, headers, body, bodyEncoding },
  };
}

/** The response of a recording, with the values of the current request. */
function fromRecording(
  { response }: Recording,
  values: RequestValues,
): ProxyResponse {
  const body = NULL_BODY_STATUSES.has(response.status)
    ? Buffer.alloc(0)
    : response.bodyEncoding === "utf8"
      ? Buffer.from(fillValues(response.body, values))
      : Buffer.from(response.body, "base64");
  return { status: response.status, headers: response.headers, body };
}

/** Create the recorder of one proxy run. */
export function createRecorder(config: RecordingProxyConfig) {
  let session: Session | undefined;
  /** Recordings that passed sessions, or requests outside one, used. */
  const used = new Set<string>();
  const stats: RecordingStats = {
    counts: Object.fromEntries(
      config.rules.map((rule) => [
        rule.name,
        { live: 0, missed: 0, replayed: 0 },
      ]),
    ),
    misses: [],
    written: 0,
    discarded: 0,
    passthrough: {},
  };
  const indexes = new Map(
    config.rules.map((rule) => [
      rule.name,
      createRecordingIndex(path.join(config.directory, rule.name)),
    ]),
  );
  const relative = (file: string) => path.relative(config.directory, file);

  const write = async (recordings: Array<[string, Recording]>) => {
    stats.written += await writeRecordings(recordings);
    for (const [file, recording] of recordings) {
      indexes.get(path.basename(path.dirname(file)))!.add(file, recording);
    }
  };

  const markReplayed = (owner: Session | undefined, file: string) => {
    if (owner && owner.passed === undefined) owner.replayed.add(file);
    else used.add(file);
  };

  const record = async (
    owner: Session | undefined,
    file: string,
    recording: Recording,
  ) => {
    if (owner && owner.passed === undefined) {
      owner.recorded.set(file, recording);
    } else if (owner?.passed === false) {
      stats.discarded += 1;
    } else {
      used.add(file);
      await write([[file, recording]]);
    }
  };

  const reportMiss = async (
    rule: RecordingRule,
    file: string,
    keyed: KeyedRequest,
    owner: Session | undefined,
  ) => {
    const closest = await indexes
      .get(rule.name)!
      .closest(keyed.parts, owner?.name);
    const miss: RecordingMiss = {
      rule: rule.name,
      session: owner?.name,
      file: relative(file),
      closest: closest && relative(closest.file),
      differs: closest?.differs ?? [],
    };
    if (stats.misses.length < MAX_MISSES) stats.misses.push(miss);
    const where = owner ? ` in "${owner.name}"` : "";
    const why = closest
      ? `closest is ${miss.closest}, which differs at ${describeParts(miss.differs)}`
      : "no recording to compare";
    process.stderr.write(
      `[recording-proxy] No ${rule.name} recording${where}: ${why}\n`,
    );
    if (config.missDirectory) {
      const target = path.join(config.missDirectory, miss.file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(
        target,
        `${JSON.stringify({ ...miss, request: keyed.normalized }, null, 2)}\n`,
      );
    }
  };

  /** End the open session. Returns its requests that `replay` mode failed. */
  const finish = async (passed: boolean): Promise<number> => {
    const ended = session;
    if (!ended) return 0;
    session = undefined;
    ended.passed = passed;
    // A failed test can still show that a recording is in use.
    for (const file of ended.replayed) used.add(file);
    if (passed) {
      for (const file of ended.recorded.keys()) used.add(file);
      await write([...ended.recorded]);
    } else {
      stats.discarded += ended.recorded.size;
      // A failed test stops early, so it does not replay all of its
      // recordings. Keep every recording that it made before, so that a
      // prune does not delete them.
      for (const index of indexes.values()) {
        for (const file of await index.filesOf(ended.name)) used.add(file);
      }
    }
    return ended.missed;
  };

  return {
    /** The rule that records a request, or `undefined` when none does. */
    ruleFor(request: ProxyRequest): RecordingRule | undefined {
      if (config.mode === "off") return undefined;
      return config.rules.find((rule) => matches(rule, request));
    },

    /** Count a request that no rule records. */
    countPassthrough(origin: string): void {
      stats.passthrough[origin] = (stats.passthrough[origin] ?? 0) + 1;
    },

    /**
     * Answer a request that `rule` records. `sendLive` sends it upstream.
     * A live response goes through the same template as a recording, so
     * the client gets the same body from a live run and from a replay.
     */
    async respond(
      rule: RecordingRule,
      request: ProxyRequest,
      sendLive: () => Promise<ProxyResponse>,
    ): Promise<ProxyResponse & { source: ResponseSource }> {
      // A request belongs to the session that was open when it started.
      const owner = session;
      const counts = stats.counts[rule.name]!;
      const keyed = keyRequest(
        rule,
        {
          method: request.method,
          url: request.url.href,
          headers: request.headers,
          body: request.body.toString("utf8"),
        },
        owner?.known,
      );
      if (owner) {
        for (const [name, list] of keyed.values) {
          for (const value of list) {
            if (!owner.known.has(value)) owner.known.set(value, name);
          }
        }
      }
      const file = path.join(config.directory, rule.name, `${keyed.key}.json`);

      if (config.mode !== "record") {
        const recording = await readRecording(file);
        if (recording) {
          counts.replayed += 1;
          markReplayed(owner, file);
          return {
            ...fromRecording(recording, keyed.values),
            source: "replayed",
          };
        }
        await reportMiss(rule, file, keyed, owner);
        if (config.mode === "replay") {
          counts.missed += 1;
          if (owner) owner.missed += 1;
          return {
            status: 412,
            headers: { "content-type": "text/plain" },
            body: Buffer.from(
              `Recording proxy: no ${rule.name} recording for this request in replay mode. Run in auto mode to record it.\n`,
            ),
            source: "missed",
          };
        }
      }

      counts.live += 1;
      const recording = toRecording(
        request,
        keyed,
        owner?.name,
        await sendLive(),
      );
      if (!isTemporaryStatus(recording.response.status)) {
        await record(owner, file, recording);
      }
      return { ...fromRecording(recording, keyed.values), source: "live" };
    },

    /** Open the session of one test. An open session fails first. */
    async startSession(name: string): Promise<void> {
      if (session) {
        process.stderr.write(
          `[recording-proxy] Session "${session.name}" did not end, so its new recordings were dropped\n`,
        );
        await finish(false);
      }
      session = {
        name,
        recorded: new Map(),
        replayed: new Set(),
        missed: 0,
        known: new Map(),
      };
    },

    /**
     * End the session `name`. Returns its requests that `replay` mode
     * failed. Throws when `name` is not the open session.
     */
    async endSession(name: string, passed: boolean): Promise<number> {
      if (session?.name !== name) {
        throw new Error(`Session "${name}" is not open`);
      }
      return finish(passed);
    },

    stats(): RecordingStats {
      return stats;
    },

    /** Fail the open session, and write `usedFile` of the config. */
    async close(): Promise<void> {
      await finish(false);
      if (config.usedFile) {
        const files = [...used].map(relative).sort();
        await writeFile(config.usedFile, files.map((f) => `${f}\n`).join(""));
      }
    },
  };
}

/** The recorder of one proxy run. */
export type Recorder = ReturnType<typeof createRecorder>;
