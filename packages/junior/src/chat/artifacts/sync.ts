/**
 * Durable conversation files.
 *
 * Every file under the Sandbox `artifacts/` directory belongs to its
 * Conversation and outlives the Sandbox. After a tool call that can change
 * files, the save step copies new and changed files to attachment storage
 * and records one row per path. When a Sandbox is prepared, the restore step
 * writes the live rows back. Nothing here reads outside `artifacts/`, so
 * `/tmp/jr` scratch files are never copied out.
 */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { bufferBody, type AttachmentStorage } from "@/chat/attachments/storage";
import { logException, logWarn } from "@/chat/logging";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { makeStructuredToolOutput } from "@/chat/tool-support/structured-result";
import { inferMimeType } from "@/chat/tools/sandbox/file-uploads";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorArtifacts } from "@/db/schema";

/** Sandbox directory, relative to the workspace root, whose files are artifacts. */
const ARTIFACTS_DIR = "artifacts";

const MAX_FILES = 200;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const TOO_LARGE = "larger than 10 MB";
const OVER_TOTAL = "over the 50 MB total limit";
/** Tools that can change files. Read-only tools skip the save step. */
const SAVE_TOOLS = new Set(["bash", "editFile", "writeFile"]);

// Regular files only. `-P` and `-type f` skip symlinks, so a link that points
// outside the directory is never read. A missing or linked directory lists
// nothing, and nothing creates it.
const LIST_SCRIPT = `if [ -d ${ARTIFACTS_DIR} ] && [ ! -L ${ARTIFACTS_DIR} ]; then find -P ${ARTIFACTS_DIR} -type f -printf '%s\\t%C@\\t%P\\0'; fi`;

/**
 * Size and status change time of one listed file. Equal stats mean
 * unchanged. The change time (ctime), not the modification time, because
 * tools such as `cp -p` and `touch -d` can set the modification time back,
 * but every write moves the change time.
 */
interface FileStat {
  bytes: number;
  changedAt: string;
}

interface ListedFile extends FileStat {
  path: string;
}

/** Run-scoped save and restore for one Conversation's artifacts. */
export interface ArtifactSync {
  /**
   * Save changed files after a tool call. Returns a note for the agent when
   * some files were not saved, or undefined.
   */
  afterToolCall(
    toolName: string,
    workspace: SandboxWorkspace,
  ): Promise<string | undefined>;
  /** Write the Conversation's live files into a new or resumed Sandbox. */
  restore(workspace: SandboxWorkspace): Promise<void>;
}

/** Return the relative path when it stays inside the artifacts directory. */
function safeArtifactPath(value: string): string | undefined {
  if (!value || value.includes("\0") || path.posix.isAbsolute(value)) {
    return undefined;
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return undefined;
  }
  return normalized;
}

function sandboxPath(artifactPath: string): string {
  return `${ARTIFACTS_DIR}/${artifactPath}`;
}

function storageKey(conversationId: string, sha256: string): string {
  return `conversations/${conversationId}/artifacts/${sha256}`;
}

async function runChecked(
  workspace: SandboxWorkspace,
  action: string,
  cmd: string,
  args: string[],
): Promise<string> {
  const result = await workspace.runCommand({
    cmd,
    args,
    cwd: SANDBOX_WORKSPACE_ROOT,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to ${action}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** List every regular file under the artifacts directory in one command. */
async function listArtifactFiles(
  workspace: SandboxWorkspace,
): Promise<ListedFile[]> {
  const stdout = await runChecked(workspace, "list artifacts", "sh", [
    "-c",
    LIST_SCRIPT,
  ]);
  return stdout
    .split("\0")
    .filter(Boolean)
    .flatMap((record) => {
      const [bytes, changedAt, ...rest] = record.split("\t");
      return bytes && changedAt && rest.length > 0
        ? [{ bytes: Number(bytes), changedAt, path: rest.join("\t") }]
        : [];
    });
}

/** Hash listed files inside the Sandbox, so restore reads no bytes back. */
async function hashArtifactFiles(
  workspace: SandboxWorkspace,
  paths: string[],
): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map();
  const stdout = await runChecked(workspace, "hash artifacts", "sha256sum", [
    "-z",
    "--",
    ...paths.map(sandboxPath),
  ]);
  const prefix = `${ARTIFACTS_DIR}/`;
  return new Map(
    stdout
      .split("\0")
      .filter(Boolean)
      .map((line) => [line.slice(66).slice(prefix.length), line.slice(0, 64)]),
  );
}

/**
 * Put the note in the structured result, so direct calls and script calls
 * both see it. Other content parts stay after it.
 */
export function withArtifactNote(result: unknown, note: string): unknown {
  if (!isRecord(result) || !isRecord(result["details"])) return result;
  const content = result["content"];
  const rest: unknown[] = Array.isArray(content) ? content.slice(1) : [];
  const output = makeStructuredToolOutput({
    ...result["details"],
    artifacts_note: note,
  });
  return { ...output, content: [...output.content, ...rest] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Create save and restore steps that share one file list for the Run. */
export function createArtifactSync(args: {
  conversationId: string;
  db: JuniorSqlDatabase;
  storage: Pick<AttachmentStorage, "get" | "put">;
}): ArtifactSync {
  const { conversationId, db, storage } = args;
  // Files that match their saved rows, as of the last save or restore. Unset
  // until a Sandbox is prepared in this Run. Only paths in this list can be
  // marked deleted, so an empty list never deletes a row.
  let known: Map<string, FileStat> | undefined;
  // Parallel tool calls save one at a time, so each save sees the list that
  // the one before it left.
  let pending: Promise<unknown> = Promise.resolve();
  // Told to the agent with the next tool result after a failed restore.
  let restoreNote: string | undefined;

  const liveRows = async () =>
    await db
      .db()
      .select({
        bytes: juniorArtifacts.bytes,
        path: juniorArtifacts.path,
        sha256: juniorArtifacts.sha256,
        storageKey: juniorArtifacts.storageKey,
      })
      .from(juniorArtifacts)
      .where(
        and(
          eq(juniorArtifacts.conversationId, conversationId),
          isNotNull(juniorArtifacts.path),
          isNull(juniorArtifacts.deleteRequestedAt),
        ),
      );

  const saveFile = async (
    file: ListedFile,
    body: Buffer,
    savedSha: string | undefined,
    storedShas: Set<string>,
  ) => {
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (sha256 === savedSha) return;
    const key = storageKey(conversationId, sha256);
    const contentType = inferMimeType(file.path);
    if (!storedShas.has(sha256)) {
      await storage.put({
        body: bufferBody(body),
        bytes: body.byteLength,
        contentType,
        key,
      });
      storedShas.add(sha256);
    }
    const values = {
      bytes: body.byteLength,
      contentType,
      deleteRequestedAt: null,
      ext: path.posix.extname(file.path).slice(1).toLowerCase(),
      sha256,
      storageKey: key,
    };
    await db
      .db()
      .insert(juniorArtifacts)
      .values({
        ...values,
        conversationId,
        createdAt: new Date(),
        id: randomUUID(),
        path: file.path,
        visibility: "conversation",
      })
      .onConflictDoUpdate({
        target: [juniorArtifacts.conversationId, juniorArtifacts.path],
        set: values,
      });
  };

  const save = async (
    workspace: SandboxWorkspace,
    previous: Map<string, FileStat>,
  ): Promise<string | undefined> => {
    const listed = (await listArtifactFiles(workspace)).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    const isUnchanged = (file: ListedFile) => {
      const stat = previous.get(file.path);
      return stat?.bytes === file.bytes && stat.changedAt === file.changedAt;
    };
    const next = new Map<string, FileStat>();
    let count = 0;
    let totalBytes = 0;
    for (const file of listed.filter(isUnchanged)) {
      next.set(file.path, { bytes: file.bytes, changedAt: file.changedAt });
      count += 1;
      totalBytes += file.bytes;
    }
    const unchangedBytes = totalBytes;

    // A known file that this save does not record stays known with a stat
    // that never matches. The next save checks it again, and still marks its
    // row deleted when the file goes away.
    const keepKnown = (filePath: string) => {
      if (previous.has(filePath))
        next.set(filePath, { bytes: -1, changedAt: "" });
    };
    const skipped: string[] = [];
    const accepted: ListedFile[] = [];
    for (const file of listed.filter((item) => !isUnchanged(item))) {
      const reason = !safeArtifactPath(file.path)
        ? "unsupported path"
        : file.bytes > MAX_FILE_BYTES
          ? TOO_LARGE
          : count >= MAX_FILES
            ? "over the 200 file limit"
            : totalBytes + file.bytes > MAX_TOTAL_BYTES
              ? OVER_TOTAL
              : undefined;
      if (reason) {
        skipped.push(`${sandboxPath(file.path)} (${reason})`);
        keepKnown(file.path);
        continue;
      }
      accepted.push(file);
      count += 1;
      totalBytes += file.bytes;
    }

    const listedPaths = new Set(listed.map((file) => file.path));
    const removed = [...previous.keys()].filter(
      (filePath) => !listedPaths.has(filePath),
    );
    if (accepted.length === 0 && removed.length === 0) {
      known = next;
      return skippedNote(skipped);
    }

    // Files can grow after the listing, so the total limit also counts the
    // bytes actually read.
    let budget = MAX_TOTAL_BYTES - unchangedBytes;
    const rows = await liveRows();
    const savedShas = new Map(rows.map((row) => [row.path, row.sha256]));
    const storedShas = new Set(rows.map((row) => row.sha256));
    for (const file of accepted) {
      // oxlint-disable-next-line no-await-in-loop -- One file in memory at a time keeps a 50 MB save bounded.
      const body = await workspace.readFileToBuffer({
        path: sandboxPath(file.path),
      });
      // Deleted after the listing. The next save sees it gone.
      if (!body) {
        keepKnown(file.path);
        continue;
      }
      const reason =
        body.byteLength > MAX_FILE_BYTES
          ? TOO_LARGE
          : body.byteLength > budget
            ? OVER_TOTAL
            : undefined;
      if (reason) {
        skipped.push(`${sandboxPath(file.path)} (${reason})`);
        keepKnown(file.path);
        continue;
      }
      budget -= body.byteLength;
      // oxlint-disable-next-line no-await-in-loop -- See the read above.
      await saveFile(file, body, savedShas.get(file.path), storedShas);
      next.set(file.path, { bytes: file.bytes, changedAt: file.changedAt });
    }
    if (removed.length > 0) {
      await db
        .db()
        .update(juniorArtifacts)
        .set({ deleteRequestedAt: new Date() })
        .where(
          and(
            eq(juniorArtifacts.conversationId, conversationId),
            inArray(juniorArtifacts.path, removed),
            isNull(juniorArtifacts.deleteRequestedAt),
          ),
        );
    }
    known = next;
    return skippedNote(skipped);
  };

  /** Write live rows back, and return the files that now match them. */
  const restoreFiles = async (
    workspace: SandboxWorkspace,
  ): Promise<Map<string, FileStat>> => {
    const rows = await liveRows();
    if (rows.length === 0) return new Map();
    const listed = new Map(
      (await listArtifactFiles(workspace)).map((file) => [file.path, file]),
    );
    const hashes = await hashArtifactFiles(
      workspace,
      rows.flatMap((row) =>
        row.path && listed.get(row.path)?.bytes === row.bytes ? [row.path] : [],
      ),
    );
    const restored = new Map<string, FileStat>();
    const written: string[] = [];
    for (const row of rows) {
      const artifactPath = row.path && safeArtifactPath(row.path);
      if (!artifactPath) continue;
      const present = listed.get(artifactPath);
      if (present && hashes.get(artifactPath) === row.sha256) {
        restored.set(artifactPath, present);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- One file in memory at a time.
      const body = await storage.get(row.storageKey);
      if (!body) {
        logWarn("artifact.restore.skipped", {
          "app.conversation.id": conversationId,
          "error.type": "object_missing",
        });
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- See the read above.
      const content = Buffer.from(await new Response(body).arrayBuffer());
      // oxlint-disable-next-line no-await-in-loop -- See the read above.
      await workspace.writeFiles([
        { content, path: sandboxPath(artifactPath) },
      ]);
      written.push(artifactPath);
    }
    if (written.length > 0) {
      // A write gives the file a new modification time.
      const relisted = new Map(
        (await listArtifactFiles(workspace)).map((file) => [file.path, file]),
      );
      for (const artifactPath of written) {
        const file = relisted.get(artifactPath);
        if (file) restored.set(artifactPath, file);
      }
    }
    return new Map(
      [...restored].map(([artifactPath, file]) => [
        artifactPath,
        { bytes: file.bytes, changedAt: file.changedAt },
      ]),
    );
  };

  return {
    async afterToolCall(toolName, workspace) {
      const notice = restoreNote;
      restoreNote = undefined;
      if (!SAVE_TOOLS.has(toolName) || !known) return notice;
      const run = pending.then(async () => {
        if (!known) return undefined;
        try {
          return await save(workspace, known);
        } catch (error) {
          // The tool already ran. A failed save must not turn its result into
          // a failure that the agent retries. The file list stays as it was,
          // so the next save tries these files again.
          logException(error, "artifact.save.failed", {
            "app.conversation.id": conversationId,
          });
          return `Files in ${ARTIFACTS_DIR}/ were not saved because the save failed. The save runs again after the next bash, writeFile, or editFile call.`;
        }
      });
      pending = run;
      const saved = await run;
      return notice && saved ? `${notice}\n\n${saved}` : (notice ?? saved);
    },

    async restore(workspace) {
      known = new Map();
      restoreNote = undefined;
      try {
        known = await restoreFiles(workspace);
      } catch (error) {
        // Tools work without saved files, so a failed restore must not stop
        // the Sandbox. The empty file list marks no row deleted, so the saved
        // copies stay for the next restore.
        logException(error, "artifact.restore.failed", {
          "app.conversation.id": conversationId,
        });
        restoreNote = `Saved files in ${ARTIFACTS_DIR}/ could not be restored to this Sandbox, so some may be missing. Their saved copies are kept.`;
      }
    },
  };
}

function skippedNote(skipped: string[]): string | undefined {
  if (skipped.length === 0) return undefined;
  return [
    `These files in ${ARTIFACTS_DIR}/ were not saved, so they will be lost when the Sandbox stops. A copy saved earlier stays as it was. Limits: ${MAX_FILES} files, 10 MB per file, 50 MB in total.`,
    ...skipped.map((entry) => `- ${entry}`),
  ].join("\n");
}
