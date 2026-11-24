/**
 * Read media files from the sandbox and send them to Vimeo upload links.
 *
 * The tools hold the whole file in memory, so the size caps stay small.
 * Upload links are one-time URLs that Vimeo returns from an authenticated
 * call, so they need no token.
 */
import path from "node:path";
import {
  PluginToolInputError,
  type PluginSandbox,
} from "@sentry/junior-plugin-api";

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Bytes per tus PATCH request. */
export const CHUNK_BYTES = 8 * 1024 * 1024;
/** Failed tries per chunk before the upload stops. */
const MAX_CHUNK_RETRIES = 3;

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/** MP4, QuickTime, or WebM, by magic bytes. */
function isVideo(bytes: Uint8Array): boolean {
  const ftyp = bytes.length > 8 && ascii(bytes, 4, 8) === "ftyp";
  const webm =
    bytes.length > 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3;
  return ftyp || webm;
}

/** Content type of a JPEG or PNG, by magic bytes. */
export function imageType(bytes: Uint8Array): string | undefined {
  if (
    bytes.length > 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (bytes.length > 8 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG") {
    return "image/png";
  }
  return undefined;
}

/**
 * Read one sandbox file that `accepts` recognizes. Only media files qualify,
 * so the tools cannot send other sandbox files out.
 */
async function readMediaFile(
  input: string,
  sandbox: PluginSandbox,
  maxBytes: number,
  accepts: (bytes: Uint8Array) => boolean,
  kind: string,
): Promise<Uint8Array> {
  const bytes = await sandbox.readFile(path.posix.resolve(sandbox.root, input));
  if (!bytes) {
    throw new PluginToolInputError(`${input} does not exist in the sandbox.`);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new PluginToolInputError(
      `${input} is ${bytes.byteLength} bytes. It must be 1 byte to ${maxBytes} bytes.`,
    );
  }
  if (!accepts(bytes)) {
    throw new PluginToolInputError(`${input} is not ${kind}.`);
  }
  return bytes;
}

/** Read an MP4, MOV, or WebM video from the sandbox. */
export function readVideo(input: string, sandbox: PluginSandbox) {
  return readMediaFile(
    input,
    sandbox,
    MAX_VIDEO_BYTES,
    isVideo,
    "an MP4, MOV, or WebM video",
  );
}

/** Read a JPEG or PNG image from the sandbox. */
export function readImage(input: string, sandbox: PluginSandbox) {
  return readMediaFile(
    input,
    sandbox,
    MAX_IMAGE_BYTES,
    (bytes) => imageType(bytes) !== undefined,
    "a JPEG or PNG image",
  );
}

/** Server offset of a tus upload. */
async function tusOffset(
  uploadLink: string,
  signal: AbortSignal | undefined,
): Promise<number> {
  const init: RequestInit = {
    method: "HEAD",
    headers: { "Tus-Resumable": "1.0.0" },
  };
  if (signal) init.signal = signal;
  const response = await fetch(uploadLink, init);
  const offset = Number(response.headers.get("Upload-Offset"));
  if (!response.ok || !Number.isInteger(offset)) {
    throw new Error(`Vimeo tus HEAD failed with HTTP ${response.status}`);
  }
  return offset;
}

/**
 * Send the bytes to a tus upload link in chunks. After a failed chunk, ask
 * the server for its offset and resume from there.
 */
export async function tusUpload(
  uploadLink: string,
  bytes: Uint8Array,
  signal: AbortSignal | undefined,
): Promise<void> {
  let offset = 0;
  let retries = 0;
  /* oxlint-disable no-await-in-loop -- tus takes each chunk at the offset that the chunk before left. */
  while (offset < bytes.byteLength) {
    const chunk = bytes.subarray(
      offset,
      Math.min(offset + CHUNK_BYTES, bytes.byteLength),
    );
    const init: RequestInit = {
      method: "PATCH",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Offset": String(offset),
        "Content-Type": "application/offset+octet-stream",
      },
      // Copy into a plain ArrayBuffer, which `fetch` accepts as a body.
      body: new Uint8Array(chunk),
    };
    if (signal) init.signal = signal;
    try {
      const response = await fetch(uploadLink, init);
      const next = Number(response.headers.get("Upload-Offset"));
      if (
        response.status !== 204 ||
        !Number.isInteger(next) ||
        next <= offset
      ) {
        throw new Error(`Vimeo tus PATCH failed with HTTP ${response.status}`);
      }
      offset = next;
      retries = 0;
    } catch (error) {
      if (signal?.aborted || retries >= MAX_CHUNK_RETRIES) throw error;
      retries += 1;
      offset = await tusOffset(uploadLink, signal);
    }
  }
  /* oxlint-enable no-await-in-loop */
}
