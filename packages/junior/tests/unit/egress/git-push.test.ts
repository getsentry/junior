import { describe, expect, it } from "vitest";
import { readGitPush } from "@/chat/egress/git-push";

const OLD_ID = "1".repeat(40);
const NEW_ID = "2".repeat(40);
const ZERO_ID = "0".repeat(40);
const FLUSH = "0000";
const PACK = "PACK\0\0\0\x02\0\0\0\x01\x9c\xff";

function pkt(line: string): string {
  const length = Buffer.byteLength(line) + 4;
  return `${length.toString(16).padStart(4, "0")}${line}`;
}

function command(ref: string, input?: { caps?: string; newId?: string }) {
  const line = `${OLD_ID} ${input?.newId ?? NEW_ID} ${ref}`;
  return pkt(input?.caps ? `${line}\0${input.caps}` : line);
}

function body(text: string): ArrayBuffer {
  // Pack bytes are binary; ref names are UTF-8.
  const bytes = Buffer.from(text, "utf8");
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}

function binaryBody(text: string): ArrayBuffer {
  return new Uint8Array([...text].map((char) => char.charCodeAt(0))).buffer;
}

describe("readGitPush", () => {
  it("reads every ref update before the pack data", () => {
    expect(
      readGitPush(
        body(
          `${command("refs/heads/feat/x", { caps: "report-status atomic" })}${command("refs/heads/main")}${FLUSH}`,
        ),
      ),
    ).toEqual({
      kind: "commands",
      updates: [
        { deletes: false, ref: "refs/heads/feat/x" },
        { deletes: false, ref: "refs/heads/main" },
      ],
    });
  });

  it("stops at the first flush, before push options and pack data", () => {
    const push = readGitPush(
      binaryBody(
        `${pkt(`shallow ${OLD_ID}`)}${command("refs/heads/feat/x", { caps: "push-options" })}${FLUSH}${pkt("ci.skip")}${FLUSH}${PACK}`,
      ),
    );

    expect(push).toMatchObject({
      kind: "commands",
      updates: [{ ref: "refs/heads/feat/x" }],
    });
  });

  it("marks a delete and decodes UTF-8 ref names", () => {
    expect(
      readGitPush(
        body(
          `${command("refs/heads/fix/café", { caps: "delete-refs", newId: ZERO_ID })}${FLUSH}`,
        ),
      ),
    ).toMatchObject({
      kind: "commands",
      updates: [{ deletes: true, ref: "refs/heads/fix/café" }],
    });
  });

  it("reads the lone flush of an auth probe as no updates", () => {
    expect(readGitPush(body(FLUSH))).toEqual({ kind: "commands", updates: [] });
  });

  it.each([
    ["gzip", binaryBody("\x1f\x8b\x08\0\0\0\0\0")],
    [
      "signed",
      body(
        `${pkt("push-cert\0report-status")}${pkt("certificate version 0.1")}${FLUSH}`,
      ),
    ],
    ["unterminated", body(command("refs/heads/feat/x"))],
    ["unterminated", undefined],
    ["malformed", body(`${pkt("not a command")}${FLUSH}`)],
    ["malformed", body(`zzzz${FLUSH}`)],
  ])("reports a %s push as unreadable", (reason, input) => {
    expect(readGitPush(input)).toEqual({ kind: "unreadable", reason });
  });
});
