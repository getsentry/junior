import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import {
  detectImageMediaType,
  type InputImageType,
} from "@/chat/attachments/media";
import { bufferBody, type AttachmentStorage } from "@/chat/attachments/storage";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorArtifacts } from "@/db/schema";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const satisfies Record<InputImageType, string>;

type ImageExtension = (typeof IMAGE_EXTENSIONS)[InputImageType];

const FILENAME_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(gif|jpg|png|webp)$/i;

function artifactKey(filename: string): string {
  return `artifacts/${filename}`;
}

function parseArtifactFilename(filename: string): {
  ext: ImageExtension;
  id: string;
} | null {
  const match = filename.match(FILENAME_RE);
  if (!match) return null;
  return {
    id: match[1]!.toLowerCase(),
    ext: match[2]!.toLowerCase() as ImageExtension,
  };
}

/** Parse a public artifact URL or filename into a content-addressed filename. */
export function artifactFilenameFromRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (FILENAME_RE.test(trimmed)) {
    const parsed = parseArtifactFilename(trimmed);
    return parsed ? `${parsed.id}.${parsed.ext}` : null;
  }
  try {
    const url = new URL(trimmed);
    const marker = "/public/artifacts/";
    const index = url.pathname.lastIndexOf(marker);
    if (index === -1) return null;
    const filename = url.pathname.slice(index + marker.length);
    const parsed = parseArtifactFilename(filename);
    return parsed ? `${parsed.id}.${parsed.ext}` : null;
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

/**
 * Publish validated image bytes as a conversation-owned public artifact.
 * With `expiresAt`, the URL stops serving at that time.
 */
export async function publishImage(args: {
  body: Buffer;
  conversationId: string;
  db: JuniorSqlDatabase;
  expiresAt?: Date;
  now?: Date;
  publicBaseUrl: string;
  storage: Pick<AttachmentStorage, "put">;
}): Promise<{
  bytes: number;
  contentType: string;
  /** Null when the URL serves until unpublished. */
  expiresAt: Date | null;
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
  const contentType = detectImageMediaType(args.body);
  if (!contentType) {
    throw new ToolInputError(
      "unsupported image format; use PNG, JPEG, GIF, or WebP",
    );
  }
  const extension = IMAGE_EXTENSIONS[contentType];

  const baseUrl = resolvePublicBaseUrl(args.publicBaseUrl);
  const sha256 = createHash("sha256").update(args.body).digest("hex");
  const now = args.now ?? new Date();

  // One public id per conversation+bytes for artifacts that do not expire.
  // An expiring artifact gets its own id, so no URL that serves longer ever
  // shares its row. Other conversations get their own id.
  const [existing] = args.expiresAt
    ? []
    : await args.db
        .db()
        .select({
          id: juniorArtifacts.id,
        })
        .from(juniorArtifacts)
        .where(
          and(
            eq(juniorArtifacts.conversationId, args.conversationId),
            eq(juniorArtifacts.sha256, sha256),
            eq(juniorArtifacts.visibility, "public"),
            isNull(juniorArtifacts.expiresAt),
          ),
        );

  const id = existing?.id ?? randomUUID();
  const filename = `${id}.${extension}`;
  const storageKey = artifactKey(filename);

  await args.storage.put({
    body: bufferBody(args.body),
    bytes: args.body.byteLength,
    contentType,
    key: storageKey,
  });

  const values = {
    bytes: args.body.byteLength,
    contentType,
    conversationId: args.conversationId,
    createdAt: now,
    deleteRequestedAt: null,
    expiresAt: args.expiresAt ?? null,
    ext: extension,
    id,
    sha256,
    storageKey,
    visibility: "public" as const,
  };
  const returning = { ext: juniorArtifacts.ext, id: juniorArtifacts.id };
  const [row] = args.expiresAt
    ? await args.db
        .db()
        .insert(juniorArtifacts)
        .values(values)
        .returning(returning)
    : // Unique on (conversation_id, sha256) among public rows that do not
      // expire. Conflict keeps the existing public id.
      await args.db
        .db()
        .insert(juniorArtifacts)
        .values(values)
        .onConflictDoUpdate({
          target: [juniorArtifacts.conversationId, juniorArtifacts.sha256],
          targetWhere: and(
            eq(juniorArtifacts.visibility, "public"),
            isNull(juniorArtifacts.expiresAt),
          ),
          set: {
            bytes: args.body.byteLength,
            contentType,
            deleteRequestedAt: null,
            ext: extension,
            // Keep the winning row's id/storage key. A raced put may leave an
            // unused object; that is fine for mvp.
          },
        })
        .returning(returning);

  if (!row) {
    throw new Error("failed to publish artifact row");
  }

  return {
    bytes: args.body.byteLength,
    contentType,
    expiresAt: args.expiresAt ?? null,
    url: `${baseUrl}/public/artifacts/${row.id}.${row.ext}`,
  };
}

/**
 * Mark one public artifact unavailable for unauthenticated reads.
 * Only the owning conversation may unpublish it.
 */
export async function unpublishArtifact(args: {
  conversationId: string;
  db: JuniorSqlDatabase;
  now?: Date;
  ref: string;
}): Promise<{ filename: string }> {
  const filename = artifactFilenameFromRef(args.ref);
  if (!filename) {
    throw new ToolInputError(
      "artifact ref must be a public artifact URL or <id>.<ext> filename",
    );
  }
  const parsed = parseArtifactFilename(filename);
  if (!parsed) {
    throw new ToolInputError(
      "artifact ref must be a public artifact URL or <id>.<ext> filename",
    );
  }

  const now = args.now ?? new Date();
  const updated = await args.db
    .db()
    .update(juniorArtifacts)
    .set({ deleteRequestedAt: now })
    .where(
      and(
        eq(juniorArtifacts.id, parsed.id),
        eq(juniorArtifacts.conversationId, args.conversationId),
      ),
    )
    .returning({ id: juniorArtifacts.id });

  if (updated.length === 0) {
    throw new ToolInputError(
      `artifact not found for this conversation: ${filename}`,
    );
  }

  return { filename };
}

/** Open one public artifact by id when the row allows it. */
export async function readPublicArtifact(args: {
  db: JuniorSqlDatabase;
  filename: string;
  storage: Pick<AttachmentStorage, "get">;
}): Promise<{
  body: ReadableStream<Uint8Array>;
  contentType: string;
  expiresAt: Date | null;
} | null> {
  const parsed = parseArtifactFilename(args.filename);
  if (!parsed) return null;

  const [row] = await args.db
    .db()
    .select({
      contentType: juniorArtifacts.contentType,
      expiresAt: juniorArtifacts.expiresAt,
      storageKey: juniorArtifacts.storageKey,
    })
    .from(juniorArtifacts)
    .where(
      and(
        eq(juniorArtifacts.id, parsed.id),
        eq(juniorArtifacts.visibility, "public"),
        isNull(juniorArtifacts.deleteRequestedAt),
        or(
          isNull(juniorArtifacts.expiresAt),
          gt(juniorArtifacts.expiresAt, new Date()),
        ),
      ),
    );

  if (!row) return null;

  const body = await args.storage.get(row.storageKey);
  if (!body) return null;
  return { body, contentType: row.contentType, expiresAt: row.expiresAt };
}

/** Build public response headers for one live public artifact. */
export function publicArtifactHeaders(
  contentType: string,
  expiresAt: Date | null = null,
): Headers {
  // Keep TTL short so unpublish can take effect, and no longer than the
  // expiry so no cache serves the artifact after it. Do not mark immutable.
  const maxAge =
    expiresAt === null
      ? 300
      : Math.min(
          300,
          Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
        );
  return new Headers({
    "cache-control": `public, max-age=${maxAge}, must-revalidate`,
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
