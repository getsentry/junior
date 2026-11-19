/**
 * Sandbox images for Slides edits.
 *
 * Google fetches the url of a createImage or replaceImage request once,
 * without credentials, and saves that URL with the image. A sandbox file has
 * no such URL. So each sandbox image is uploaded to the Drive of Junior's
 * account and shared with anyone who has the link only while the edit runs.
 * Then the upload is deleted, whether the edit applied or not, so the saved
 * URL opens nothing.
 */
import { posix } from "node:path";
import { PluginToolInputError } from "@sentry/junior-plugin-api";
import pLimit from "p-limit";
import * as z from "zod";
import { newEditableFile, type EditableFile } from "./editable-file";
import {
  googleApiError,
  googleApiRequest,
  type GoogleToolContext,
} from "./shared";

// Request kinds that take an image url. Each request has one key.
const IMAGE_REQUEST_KINDS = ["createImage", "replaceImage"] as const;
// Google takes images under 50 MB. It also refuses more than 25 megapixels,
// which only Google checks.
const MAX_IMAGE_BYTES = 50_000_000;
const IMAGE_SIGNATURES = [
  {
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    mimeType: "image/png",
  },
  { bytes: [0xff, 0xd8, 0xff], mimeType: "image/jpeg" },
  { bytes: [0x47, 0x49, 0x46, 0x38], mimeType: "image/gif" },
] as const;
const DRIVE_CONCURRENCY = 4;

const imageRequestSchema = z.object({ url: z.string() }).loose();
const uploadedSchema = z.object({
  id: z.string(),
  webContentLink: z.string().optional(),
});

/** Return the image request in `request` when its url is a sandbox path. */
function sandboxImage(request: Record<string, unknown>) {
  for (const kind of IMAGE_REQUEST_KINDS) {
    const body = imageRequestSchema.safeParse(request[kind]).data;
    if (body?.url.startsWith("/")) return { body, kind, path: body.url };
  }
  return undefined;
}

/** Return each sandbox path that the requests use as an image url, once. */
export function sandboxImagePaths(
  requests: Array<Record<string, unknown>>,
): string[] {
  return [
    ...new Set(
      requests.flatMap((request) => sandboxImage(request)?.path ?? []),
    ),
  ];
}

const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Read one sandbox image, upload it, and share it with anyone who has the
 * link. Return its download link. The upload goes on `uploads` as soon as it
 * exists, so the caller deletes it even when sharing fails.
 */
async function shareImage(
  ctx: GoogleToolContext,
  path: string,
  uploads: EditableFile[],
): Promise<[string, string]> {
  const bytes = await ctx.sandbox.readFile(path);
  if (!bytes) {
    throw new PluginToolInputError(`No sandbox file at ${path}.`);
  }
  if (bytes.byteLength >= MAX_IMAGE_BYTES) {
    throw new PluginToolInputError(
      `${path} is ${Math.ceil(bytes.byteLength / 1_000_000)} MB. Google Slides takes images under 50 MB.`,
    );
  }
  const mimeType = IMAGE_SIGNATURES.find(({ bytes: signature }) =>
    signature.every((byte, index) => bytes[index] === byte),
  )?.mimeType;
  if (!mimeType) {
    throw new PluginToolInputError(`${path} is not a PNG, JPEG, or GIF.`);
  }

  const created = await googleApiRequest(ctx, {
    body: bytes,
    headers: { "Content-Type": mimeType },
    operation: "google.drive.file.create",
    path: "/upload/drive/v3/files",
    query: { fields: "id,webContentLink", uploadType: "media" },
  });
  if (created.status !== 200) {
    throw googleApiError("google.drive.file.create", created);
  }
  const uploaded = uploadedSchema.parse(created.body);
  const file = newEditableFile({ fileId: uploaded.id }, posix.basename(path));
  uploads.push(file);
  if (!uploaded.webContentLink) {
    throw new Error(`Drive returned no download link for ${path}.`);
  }

  const shared = await googleApiRequest(ctx, {
    body: { role: "reader", type: "anyone" },
    editable: file,
    operation: "google.drive.permission.create",
    path: `/drive/v3/files/${uploaded.id}/permissions`,
  });
  // Workspace sharing settings can forbid sharing a file with anyone who has
  // the link. Google answers 400 or 403.
  if (shared.status === 400 || shared.status === 403) {
    throw new PluginToolInputError(
      `${googleApiError("google.drive.permission.create", shared).message}. Google Slides fetches an image only from a link that anyone can open, and the Workspace sharing settings of ${ctx.accountEmail} may not allow that link. Use a public image URL instead.`,
    );
  }
  if (shared.status !== 200) {
    throw googleApiError("google.drive.permission.create", shared);
  }
  return [path, uploaded.webContentLink];
}

async function deleteImage(
  ctx: GoogleToolContext,
  file: EditableFile,
): Promise<void> {
  const deleted = await googleApiRequest(ctx, {
    editable: file,
    operation: "google.drive.file.delete",
    path: `/drive/v3/files/${file.ref.fileId}`,
  });
  if (deleted.status !== 204 && deleted.status !== 200) {
    throw googleApiError("google.drive.file.delete", deleted);
  }
}

/**
 * Run `apply` with the requests, after each sandbox path used as an image
 * url is replaced by the link of its upload. Every upload is deleted before
 * this returns or throws.
 */
export async function withSandboxImages<T>(
  ctx: GoogleToolContext,
  requests: Array<Record<string, unknown>>,
  apply: (requests: Array<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  const paths = sandboxImagePaths(requests);
  if (paths.length === 0) return await apply(requests);
  for (const path of paths) {
    if (
      posix.normalize(path) !== path ||
      !path.startsWith(`${ctx.sandbox.root}/`)
    ) {
      throw new PluginToolInputError(
        `An image path must be a normalized absolute path under ${ctx.sandbox.root}, not ${path}.`,
      );
    }
  }

  const uploads: EditableFile[] = [];
  let outcome: { applied: true; value: T } | { applied: false; error: unknown };
  try {
    // Wait for every upload, even after one fails, so that each one is on
    // `uploads` before the deletes start.
    const shared = await pLimit(DRIVE_CONCURRENCY).map(paths, (path) =>
      shareImage(ctx, path, uploads).then(
        (link) => ({ link }),
        (error: unknown) => ({ error }),
      ),
    );
    const failed = shared.find((result) => "error" in result);
    if (failed) throw failed.error;
    const links = new Map(
      shared.flatMap((result) => ("link" in result ? [result.link] : [])),
    );
    const linked = requests.map((request) => {
      const image = sandboxImage(request);
      return image
        ? { [image.kind]: { ...image.body, url: links.get(image.path) } }
        : request;
    });
    outcome = { applied: true, value: await apply(linked) };
  } catch (error) {
    outcome = { applied: false, error };
  }

  const left = (
    await pLimit(DRIVE_CONCURRENCY).map(uploads, (file) =>
      deleteImage(ctx, file).then(
        () => [],
        (error: unknown) => [{ error, file }],
      ),
    )
  ).flat();
  if (left.length > 0) {
    const files = left
      .map(({ file }) => `${file.title} (${file.ref.fileId})`)
      .join(", ");
    const before = outcome.applied
      ? "The edit applied"
      : reason(outcome.error).replace(/\.$/, "");
    throw new Error(
      `${before}. Deleting the uploaded image ${files} failed: ${reason(left[0]?.error)}. Anyone with its link can still open it; delete it from the Drive of ${ctx.accountEmail}.`,
      { cause: outcome.applied ? left[0]?.error : outcome.error },
    );
  }
  if (!outcome.applied) throw outcome.error;
  return outcome.value;
}
