/**
 * Vimeo API calls and the shared shapes of the Vimeo tools.
 *
 * Every API call goes through plugin egress with one operation per tool.
 * Junior adds the service account's token on the host, so plugin code, the
 * sandbox, and the model never hold it.
 */
import {
  PluginToolInputError,
  pluginToolOutputSchema,
  type PluginEgress,
} from "@sentry/junior-plugin-api";
import * as z from "zod";

const API = "https://api.vimeo.com";
/** Videos per page of a folder listing. */
export const PAGE_SIZE = 100;
/** Most embed domains one video may have. */
export const MAX_EMBED_DOMAINS = 10;

/** One egress operation per tool. The service account serves only these. */
export const VIMEO_OPERATIONS = {
  upload: "vimeo.upload",
  replaceFile: "vimeo.replace_file",
  setThumbnail: "vimeo.set_thumbnail",
  status: "vimeo.status",
  listFolder: "vimeo.list_folder",
} as const;
type Operation = (typeof VIMEO_OPERATIONS)[keyof typeof VIMEO_OPERATIONS];

/** Fields that the tools read from a Vimeo video. */
export const VIDEO_FIELDS = [
  "uri",
  "name",
  "link",
  "player_embed_url",
  "privacy",
  "status",
  "upload.status",
  "transcode.status",
  "duration",
  "pictures.base_link",
  "parent_folder.uri",
].join(",");

const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const VIDEO_ID_RE = /^\d{1,20}$/;
const HASH_RE = /^[0-9a-f]{6,}$/i;
// A team folder lives under the team owner: `/users/<owner>/projects/<id>`.
// The API also calls folders `folders`.
const FOLDER_URI_RE = /^\/users\/(\d{1,20})\/(?:projects|folders)\/(\d{1,20})$/;

const videoSchema = z
  .object({
    uri: z.string(),
    name: z.string().nullish(),
    link: z.string().nullish(),
    player_embed_url: z.string().nullish(),
    privacy: z
      .object({ view: z.string(), embed: z.string() })
      .partial()
      .nullish(),
    status: z.string().nullish(),
    upload: z.object({ status: z.string().nullish() }).nullish(),
    transcode: z.object({ status: z.string().nullish() }).nullish(),
    duration: z.number().nullish(),
    pictures: z.object({ base_link: z.string().nullish() }).nullish(),
    parent_folder: z.object({ uri: z.string().nullish() }).nullish(),
  })
  .passthrough();

/** A Vimeo video as the tools read it. */
export type Video = z.output<typeof videoSchema>;

/** One page of videos in a folder. */
export const folderPageSchema = z.object({
  data: z.array(videoSchema).max(PAGE_SIZE),
  paging: z.object({ next: z.string().nullish() }).nullish(),
});

/** Upload attempt for a new video or a new file version. */
export const uploadAttemptSchema = z.object({
  uri: z.string().optional(),
  upload: z.object({ upload_link: z.string().url() }),
});

/** Result fields of one video. */
export const videoFields = {
  video_id: z.string(),
  name: z.string().optional(),
  hash: z.string().optional(),
  embed_url: z.string(),
  link: z.string().optional(),
  view: z.string().optional(),
  embed: z.string().optional(),
  upload_status: z.string().optional(),
  transcode_status: z.string().optional(),
  ready: z.boolean(),
  duration_seconds: z.number().optional(),
  thumbnail_url: z.string().optional(),
};
/** Output of the tools that return one video. */
export const videoOutputSchema = pluginToolOutputSchema.extend(videoFields);

/** Numeric Vimeo video ID. */
export const videoIdSchema = z
  .string()
  .trim()
  .regex(VIDEO_ID_RE, "Use the numeric Vimeo video ID")
  .describe("Numeric Vimeo video ID, such as the one vimeo_upload returned.");

/** Bare hostname where a video may be embedded. */
export const embedDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(HOSTNAME_RE, "Use a bare hostname, such as www.example.com");

/** Sandbox path of a file that a tool reads. */
export const sandboxPathSchema = (what: string) =>
  z.string().trim().min(1).describe(`Sandbox path of the ${what}.`);

/** Owner and canonical URI of a Vimeo folder URI, or undefined. */
export function parseFolder(
  value: string,
): { owner: string; uri: string } | undefined {
  const match = FOLDER_URI_RE.exec(value);
  if (!match) return undefined;
  return { owner: match[1]!, uri: `/users/${match[1]}/projects/${match[2]}` };
}

/** Validated install settings that every Vimeo tool reads. */
export interface VimeoSettings {
  folder: { owner: string; uri: string };
  embedDomains: string[];
}

/**
 * Fail unless the video is in the install's folder. The Vimeo account is
 * shared by every requester, so the tools never reach other videos that the
 * account can read or edit.
 */
export function assertInFolder(video: Video, settings: VimeoSettings): void {
  const { uri } = settings.folder;
  const parent = video.parent_folder?.uri;
  if (!parent || parseFolder(parent)?.uri !== uri) {
    throw new PluginToolInputError(
      `Vimeo video ${videoIdFromUri(video.uri)} is not in ${uri}. The Vimeo tools use only videos in that folder; use vimeo_listFolder to find them.`,
    );
  }
}

/** Embed domains from input, else the install's default domains. */
export function resolveEmbedDomains(
  input: string[] | undefined,
  settings: VimeoSettings,
): string[] {
  if (input) return input;
  if (settings.embedDomains.length === 0) {
    throw new PluginToolInputError(
      "The install sets no default embed domains. Pass the hostnames where the video may be embedded.",
    );
  }
  return settings.embedDomains;
}

/** Vimeo API calls for one tool call. */
export interface VimeoClient {
  /** Call the Vimeo API and return its JSON body, or nothing for 204. */
  api(method: string, route: string, body?: unknown): Promise<unknown>;
  getVideo(id: string): Promise<Video>;
}

/** Reach the Vimeo API through plugin egress for one operation. */
export function vimeoClient(
  egress: PluginEgress,
  operation: Operation,
  signal: AbortSignal | undefined,
): VimeoClient {
  const api: VimeoClient["api"] = async (method, route, body) => {
    const headers: Record<string, string> = {
      Accept: "application/vnd.vimeo.*+json;version=3.4",
    };
    const init: RequestInit = { method, headers, redirect: "error" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (signal) init.signal = signal;
    const response = await egress.fetch({
      operation,
      provider: "vimeo",
      request: new Request(`${API}${route}`, init),
    });
    if (!response.ok) {
      const message = `Vimeo ${method} ${route} failed with HTTP ${response.status}: ${await errorDetail(response)}`;
      if ([400, 403, 404].includes(response.status)) {
        throw new PluginToolInputError(
          `${message}. Check the IDs and the folder.`,
        );
      }
      throw new Error(message);
    }
    return response.status === 204 ? undefined : response.json();
  };
  return {
    api,
    getVideo: async (id) =>
      videoSchema.parse(
        await api("GET", `/videos/${id}?fields=${VIDEO_FIELDS}`),
      ),
  };
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  const parsed = z
    .object({
      error: z.string().optional(),
      developer_message: z.string().optional(),
    })
    .safeParse(safeJson(text));
  const detail = parsed.success
    ? [parsed.data.error, parsed.data.developer_message]
        .filter(Boolean)
        .join(" ")
    : "";
  return detail || text.slice(0, 300);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Vimeo video ID from a URI such as `/videos/123`. */
export function videoIdFromUri(uri: string): string {
  const id = uri.split("/").pop() ?? "";
  if (!VIDEO_ID_RE.test(id)) {
    throw new Error(`Vimeo returned an unexpected video URI: ${uri}`);
  }
  return id;
}

/**
 * Privacy hash of an unlisted video. Vimeo puts it in the `h` query param of
 * the player URL and in the last path segment of `vimeo.com/<id>/<hash>`.
 */
function videoHash(video: Video, id: string): string | undefined {
  if (video.player_embed_url) {
    const h = new URL(video.player_embed_url).searchParams.get("h");
    if (h && HASH_RE.test(h)) return h;
  }
  if (video.link) {
    const [first, second] = new URL(video.link).pathname
      .split("/")
      .filter(Boolean);
    if (first === id && second && HASH_RE.test(second)) return second;
  }
  return undefined;
}

/** Select the result fields of one video. */
export function describeVideo(video: Video): z.input<typeof videoOutputSchema> {
  const id = videoIdFromUri(video.uri);
  const hash = videoHash(video, id);
  const transcodeStatus = video.transcode?.status ?? undefined;
  return {
    video_id: id,
    name: video.name ?? undefined,
    hash,
    embed_url: `https://player.vimeo.com/video/${id}${hash ? `?h=${hash}` : ""}`,
    link: video.link ?? undefined,
    view: video.privacy?.view,
    embed: video.privacy?.embed,
    upload_status: video.upload?.status ?? undefined,
    transcode_status: transcodeStatus,
    ready: transcodeStatus === "complete" || video.status === "available",
    duration_seconds: video.duration || undefined,
    thumbnail_url: video.pictures?.base_link ?? undefined,
  };
}
