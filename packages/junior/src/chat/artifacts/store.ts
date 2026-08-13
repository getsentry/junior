import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorArtifacts } from "@/db/schema";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = {
  gif: "image/gif",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

type ImageExtension = keyof typeof IMAGE_TYPES;

const FILENAME_RE = /^([a-f0-9]{64})\.(gif|jpg|png|webp)$/;

function detectImageType(data: Buffer): {
  contentType: (typeof IMAGE_TYPES)[ImageExtension];
  extension: ImageExtension;
} | null {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return { contentType: IMAGE_TYPES.png, extension: "png" };
  }
  if (
    data.length >= 3 &&
    data[0] === 255 &&
    data[1] === 216 &&
    data[2] === 255
  ) {
    return { contentType: IMAGE_TYPES.jpg, extension: "jpg" };
  }
  if (
    data.length >= 6 &&
    (data.subarray(0, 6).toString("ascii") === "GIF87a" ||
      data.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return { contentType: IMAGE_TYPES.gif, extension: "gif" };
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { contentType: IMAGE_TYPES.webp, extension: "webp" };
  }
  return null;
}

function artifactKey(filename: string): string {
  return `artifacts/${filename}`;
}

function parseArtifactFilename(filename: string): {
  ext: ImageExtension;
  sha256: string;
} | null {
  const match = filename.match(FILENAME_RE);
  if (!match) return null;
  return {
    sha256: match[1]!,
    ext: match[2] as ImageExtension,
  };
}

/** Parse a public artifact URL or content-addressed filename into a filename. */
export function artifactFilenameFromRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (FILENAME_RE.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const marker = "/public/artifacts/";
    const index = url.pathname.lastIndexOf(marker);
    if (index === -1) return null;
    const filename = url.pathname.slice(index + marker.length);
    return FILENAME_RE.test(filename) ? filename : null;
  } catch {
    return null;
  }
}

function resolvePublicBaseUrl(publicBaseUrl: string): string {
  const baseUrl = publicBaseUrl.trim().replace(/\/+$/, "");
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error("public base URL must be an absolute HTTP(S) URL");
  }
  if (
    parsedBaseUrl.protocol !== "http:" &&
    parsedBaseUrl.protocol !== "https:"
  ) {
    throw new Error("public base URL must use HTTP(S)");
  }
  return baseUrl;
}

/** Publish validated image bytes as a public content-addressed artifact. */
export async function publishImage(args: {
  body: Buffer;
  db: JuniorSqlDatabase;
  now?: Date;
  publicBaseUrl: string;
  storage: Pick<AttachmentStorage, "put">;
}): Promise<{
  bytes: number;
  contentType: string;
  url: string;
}> {
  if (args.body.byteLength === 0) {
    throw new ToolInputError("image is empty");
  }
  if (args.body.byteLength > MAX_IMAGE_BYTES) {
    throw new ToolInputError(
      `image exceeds ${MAX_IMAGE_BYTES} bytes (${args.body.byteLength} bytes)`,
    );
  }
  const imageType = detectImageType(args.body);
  if (!imageType) {
    throw new ToolInputError(
      "unsupported image format; use PNG, JPEG, GIF, or WebP",
    );
  }

  const baseUrl = resolvePublicBaseUrl(args.publicBaseUrl);
  const sha256 = createHash("sha256").update(args.body).digest("hex");
  const filename = `${sha256}.${imageType.extension}`;
  const storageKey = artifactKey(filename);
  const now = args.now ?? new Date();

  await args.storage.put({
    body: args.body,
    contentType: imageType.contentType,
    key: storageKey,
  });

  await args.db
    .db()
    .insert(juniorArtifacts)
    .values({
      bytes: args.body.byteLength,
      contentType: imageType.contentType,
      createdAt: now,
      deleteRequestedAt: null,
      ext: imageType.extension,
      public: true,
      sha256,
      storageKey,
    })
    .onConflictDoUpdate({
      target: juniorArtifacts.sha256,
      set: {
        bytes: args.body.byteLength,
        contentType: imageType.contentType,
        deleteRequestedAt: null,
        ext: imageType.extension,
        public: true,
        storageKey,
      },
    });

  return {
    bytes: args.body.byteLength,
    contentType: imageType.contentType,
    url: `${baseUrl}/public/artifacts/${filename}`,
  };
}

/** Mark one public artifact unavailable for unauthenticated reads. */
export async function unpublishArtifact(args: {
  db: JuniorSqlDatabase;
  now?: Date;
  ref: string;
}): Promise<{ filename: string }> {
  const filename = artifactFilenameFromRef(args.ref);
  if (!filename) {
    throw new ToolInputError(
      "artifact ref must be a public artifact URL or <sha256>.<ext> filename",
    );
  }
  const parsed = parseArtifactFilename(filename);
  if (!parsed) {
    throw new ToolInputError(
      "artifact ref must be a public artifact URL or <sha256>.<ext> filename",
    );
  }

  const now = args.now ?? new Date();
  const updated = await args.db
    .db()
    .update(juniorArtifacts)
    .set({ deleteRequestedAt: now })
    .where(eq(juniorArtifacts.sha256, parsed.sha256))
    .returning({ sha256: juniorArtifacts.sha256 });

  if (updated.length === 0) {
    throw new ToolInputError(`artifact not found: ${filename}`);
  }

  return { filename };
}

/** Open one public artifact by content-addressed filename when the row allows it. */
export async function readPublicArtifact(args: {
  db: JuniorSqlDatabase;
  filename: string;
  storage: Pick<AttachmentStorage, "get">;
}): Promise<{
  body: ReadableStream<Uint8Array>;
  contentType: string;
} | null> {
  const parsed = parseArtifactFilename(args.filename);
  if (!parsed) return null;

  const [row] = await args.db
    .db()
    .select({
      contentType: juniorArtifacts.contentType,
      deleteRequestedAt: juniorArtifacts.deleteRequestedAt,
      public: juniorArtifacts.public,
      storageKey: juniorArtifacts.storageKey,
    })
    .from(juniorArtifacts)
    .where(
      and(
        eq(juniorArtifacts.sha256, parsed.sha256),
        eq(juniorArtifacts.public, true),
        isNull(juniorArtifacts.deleteRequestedAt),
      ),
    );

  if (!row) return null;

  const body = await args.storage.get(row.storageKey);
  if (!body) return null;
  return { body, contentType: row.contentType };
}

/** Build immutable public response headers for one live public artifact. */
export function publicArtifactHeaders(contentType: string): Headers {
  return new Headers({
    "cache-control": "public, max-age=31536000, immutable",
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  });
}

/** Build short-lived headers for missing or unpublished artifact responses. */
export function unpublishedArtifactHeaders(): Headers {
  return new Headers({
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
}
