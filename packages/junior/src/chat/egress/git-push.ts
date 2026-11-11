/**
 * Git smart HTTP push reading for egress hooks.
 *
 * A `git-receive-pack` body starts with pkt-line ref update commands and a
 * flush packet, then the pack data. The host reads the commands, so a plugin
 * can judge a push without parsing the wire format.
 */
import type {
  PluginGitPush,
  PluginGitPushUnreadableReason,
  PluginGitRefUpdate,
} from "@sentry/junior-plugin-api";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ZERO_OBJECT_ID = /^0+$/;
const PKT_LENGTH = /^[0-9a-f]{4}$/i;

/** Match a Git push request. */
export function isGitReceivePack(method: string, upstreamUrl: URL): boolean {
  return (
    method.toUpperCase() === "POST" &&
    upstreamUrl.pathname.toLowerCase().endsWith("/git-receive-pack")
  );
}

function unreadable(reason: PluginGitPushUnreadableReason): PluginGitPush {
  return { kind: "unreadable", reason };
}

/**
 * Read the ref update commands from a `git-receive-pack` body.
 *
 * The command list ends at the first flush packet, so push options and pack
 * data after it do not matter. A signed push nests its commands in a
 * certificate, so it is reported as unreadable.
 */
export function readGitPush(body: ArrayBuffer | undefined): PluginGitPush {
  const bytes = new Uint8Array(body ?? new ArrayBuffer(0));
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return unreadable("gzip");
  }
  const decoder = new TextDecoder();
  const updates: PluginGitRefUpdate[] = [];
  let offset = 0;
  while (true) {
    if (offset + 4 > bytes.length) {
      return unreadable("unterminated");
    }
    const lengthText = String.fromCharCode(
      ...bytes.subarray(offset, offset + 4),
    );
    if (!PKT_LENGTH.test(lengthText)) {
      return unreadable("malformed");
    }
    const length = Number.parseInt(lengthText, 16);
    if (length === 0) {
      return { kind: "commands", updates };
    }
    if (length < 4) {
      return unreadable("malformed");
    }
    if (offset + length > bytes.length) {
      return unreadable("unterminated");
    }
    const line = decoder
      .decode(bytes.subarray(offset + 4, offset + length))
      .replace(/\n$/, "");
    offset += length;
    if (line.startsWith("shallow ")) {
      continue;
    }
    // Capabilities follow a NUL byte on the first command only.
    const command = line.split("\0", 1)[0]!;
    if (command === "push-cert") {
      return unreadable("signed");
    }
    const [oldId, newId, ref, ...rest] = command.split(" ");
    if (
      !oldId ||
      !newId ||
      !ref ||
      rest.length > 0 ||
      !OBJECT_ID.test(oldId) ||
      !OBJECT_ID.test(newId)
    ) {
      return unreadable("malformed");
    }
    updates.push({ deletes: ZERO_OBJECT_ID.test(newId), ref });
  }
}
