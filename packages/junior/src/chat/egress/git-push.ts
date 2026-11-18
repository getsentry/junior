/**
 * Git smart HTTP push reading for egress hooks.
 *
 * A `git-receive-pack` body starts with pkt-line ref update commands and a
 * flush packet, then optional push options and the pack data. The host reads
 * the commands and the pack object count, so a plugin can judge a push
 * without parsing the wire format.
 */
import type {
  PluginGitPush,
  PluginGitPushUnreadableReason,
  PluginGitRefUpdate,
} from "@sentry/junior-plugin-api";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ZERO_OBJECT_ID = /^0+$/;
const PKT_LENGTH = /^[0-9a-f]{4}$/i;
const PACK_SIGNATURE = "PACK";
// Signature, version, then the object count as a 32-bit big-endian number.
const PACK_HEADER_LENGTH = 12;

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

type PktLine =
  | { kind: "flush"; next: number }
  | { kind: "line"; next: number; text: string }
  | { kind: "unreadable"; reason: PluginGitPushUnreadableReason };

function readPktLine(bytes: Uint8Array, offset: number): PktLine {
  if (offset + 4 > bytes.length) {
    return { kind: "unreadable", reason: "unterminated" };
  }
  const lengthText = String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (!PKT_LENGTH.test(lengthText)) {
    return { kind: "unreadable", reason: "malformed" };
  }
  const length = Number.parseInt(lengthText, 16);
  if (length === 0) {
    return { kind: "flush", next: offset + 4 };
  }
  if (length < 4) {
    return { kind: "unreadable", reason: "malformed" };
  }
  if (offset + length > bytes.length) {
    return { kind: "unreadable", reason: "unterminated" };
  }
  const text = new TextDecoder()
    .decode(bytes.subarray(offset + 4, offset + length))
    .replace(/\n$/, "");
  return { kind: "line", next: offset + length, text };
}

/** Read the pack object count after the commands, or zero with no pack. */
function readPackObjectCount(
  bytes: Uint8Array,
  offset: number,
  pushOptions: boolean,
): number | PluginGitPushUnreadableReason {
  let packOffset = offset;
  // Push options follow the commands, up to their own flush packet.
  while (pushOptions) {
    const line = readPktLine(bytes, packOffset);
    if (line.kind === "unreadable") {
      return line.reason;
    }
    packOffset = line.next;
    if (line.kind === "flush") {
      break;
    }
  }
  if (packOffset === bytes.length) {
    return 0;
  }
  if (
    packOffset + PACK_HEADER_LENGTH > bytes.length ||
    String.fromCharCode(...bytes.subarray(packOffset, packOffset + 4)) !==
      PACK_SIGNATURE
  ) {
    return "malformed";
  }
  return new DataView(
    bytes.buffer,
    bytes.byteOffset + packOffset + 8,
    4,
  ).getUint32(0);
}

/**
 * Read the ref update commands and the pack object count from a
 * `git-receive-pack` body.
 *
 * The command list ends at the first flush packet. Push options, when the
 * client sends them, end at the next one. Only the pack header after them is
 * read. A signed push nests its commands in a certificate, so it is reported
 * as unreadable.
 */
export function readGitPush(body: ArrayBuffer | undefined): PluginGitPush {
  const bytes = new Uint8Array(body ?? new ArrayBuffer(0));
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return unreadable("gzip");
  }
  const updates: PluginGitRefUpdate[] = [];
  let pushOptions = false;
  let offset = 0;
  while (true) {
    const pkt = readPktLine(bytes, offset);
    if (pkt.kind === "unreadable") {
      return unreadable(pkt.reason);
    }
    offset = pkt.next;
    if (pkt.kind === "flush") {
      const packObjectCount = readPackObjectCount(bytes, offset, pushOptions);
      return typeof packObjectCount === "number"
        ? { kind: "commands", packObjectCount, updates }
        : unreadable(packObjectCount);
    }
    if (pkt.text.startsWith("shallow ")) {
      continue;
    }
    // Capabilities follow a NUL byte on the first command only.
    const [command = "", capabilities = ""] = pkt.text.split("\0", 2);
    if (command === "push-cert") {
      return unreadable("signed");
    }
    if (capabilities.split(" ").includes("push-options")) {
      pushOptions = true;
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
    updates.push({
      creates: ZERO_OBJECT_ID.test(oldId),
      deletes: ZERO_OBJECT_ID.test(newId),
      ref,
    });
  }
}
