import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { createArtifactSync } from "@/chat/artifacts/sync";
import { juniorArtifacts } from "@/db/schema";
import { localWorkspace } from "../fixtures/local-workspace";
import {
  createJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../fixtures/sql";

const CONVERSATION_ID = "slack:C-artifacts:1";
const MIB = 1024 * 1024;

describe("conversation artifacts", () => {
  let fixture: LocalJuniorSqlFixture;
  const roots: string[] = [];

  beforeEach(async () => {
    fixture = await createJuniorSqlFixture();
  });

  afterEach(async () => {
    await fixture.close();
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { force: true, recursive: true })),
    );
  });

  /** A new, empty Sandbox. */
  async function newSandbox() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "junior-artifacts-"));
    roots.push(root);
    const write = async (file: string, content: string | Buffer) => {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), content);
    };
    return { root, workspace: localWorkspace(root), write };
  }

  /** The run-scoped sync that Junior creates for each Run. */
  function newRun(storage: ReturnType<typeof createMemoryAttachmentStorage>) {
    return createArtifactSync({
      conversationId: CONVERSATION_ID,
      db: fixture.sql,
      storage,
    });
  }

  async function rows() {
    return await fixture.sql
      .db()
      .select({
        deleteRequestedAt: juniorArtifacts.deleteRequestedAt,
        path: juniorArtifacts.path,
        visibility: juniorArtifacts.visibility,
      })
      .from(juniorArtifacts)
      .where(eq(juniorArtifacts.conversationId, CONVERSATION_ID))
      .orderBy(juniorArtifacts.path);
  }

  it("restores saved files in a new Sandbox and forgets deleted ones", async () => {
    const storage = createMemoryAttachmentStorage();
    const first = await newSandbox();
    const firstRun = newRun(storage);
    await firstRun.restore(first.workspace);
    // No artifacts directory yet: nothing is listed or created.
    expect(await firstRun.afterToolCall("bash", first.workspace)).toBe(
      undefined,
    );
    await expect(fs.stat(path.join(first.root, "artifacts"))).rejects.toThrow(
      "ENOENT",
    );

    await first.write("artifacts/report.md", "# Report\n");
    await first.write("artifacts/data/rows.json", "[1,2,3]");
    await first.write("artifacts/copy.md", "# Report\n");
    await first.write("notes.txt", "outside the artifacts directory");
    // Read-only tools do not save.
    await firstRun.afterToolCall("readFile", first.workspace);
    expect(await rows()).toEqual([]);

    expect(await firstRun.afterToolCall("bash", first.workspace)).toBe(
      undefined,
    );
    expect(await rows()).toEqual([
      { deleteRequestedAt: null, path: "copy.md", visibility: "conversation" },
      {
        deleteRequestedAt: null,
        path: "data/rows.json",
        visibility: "conversation",
      },
      {
        deleteRequestedAt: null,
        path: "report.md",
        visibility: "conversation",
      },
    ]);
    // Equal bytes share one stored object.
    expect(storage.objects.size).toBe(2);

    // Resuming the same Sandbox writes nothing back.
    const resumedRun = newRun(storage);
    await resumedRun.restore(first.workspace);
    expect(first.workspace.writes).toEqual([]);

    const second = await newSandbox();
    const secondRun = newRun(storage);
    await secondRun.restore(second.workspace);
    expect(
      await fs.readFile(path.join(second.root, "artifacts/report.md"), "utf8"),
    ).toBe("# Report\n");
    expect(
      await fs.readFile(
        path.join(second.root, "artifacts/data/rows.json"),
        "utf8",
      ),
    ).toBe("[1,2,3]");
    await expect(fs.stat(path.join(second.root, "notes.txt"))).rejects.toThrow(
      "ENOENT",
    );

    await fs.rm(path.join(second.root, "artifacts/copy.md"));
    await second.write("artifacts/report.md", "# Report v2\n");
    await secondRun.afterToolCall("writeFile", second.workspace);
    expect(
      (await rows()).map((row) => [row.path, row.deleteRequestedAt !== null]),
    ).toEqual([
      ["copy.md", true],
      ["data/rows.json", false],
      ["report.md", false],
    ]);

    const third = await newSandbox();
    await newRun(storage).restore(third.workspace);
    expect(
      (
        await fs.readdir(path.join(third.root, "artifacts"), {
          recursive: true,
        })
      ).sort(),
    ).toEqual(["data", "data/rows.json", "report.md"]);
    expect(
      await fs.readFile(path.join(third.root, "artifacts/report.md"), "utf8"),
    ).toBe("# Report v2\n");
  });

  it("skips files over the limits and links out of the directory, and says why", async () => {
    const storage = createMemoryAttachmentStorage();
    const sandbox = await newSandbox();
    const run = newRun(storage);
    await run.restore(sandbox.workspace);
    await sandbox.write("secret.txt", "outside");
    await sandbox.write("artifacts/small.txt", "ok");
    await sandbox.write("artifacts/big.bin", Buffer.alloc(11 * MIB));
    await fs.symlink(
      path.join(sandbox.root, "secret.txt"),
      path.join(sandbox.root, "artifacts/link.txt"),
    );

    const note = await run.afterToolCall("bash", sandbox.workspace);

    expect(note).toContain("artifacts/big.bin (larger than 10 MB)");
    expect(note).not.toContain("link.txt");
    expect((await rows()).map((row) => row.path)).toEqual(["small.txt"]);
    expect([...storage.objects.values()].map(String)).toEqual(["ok"]);
  });
});
