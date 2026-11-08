// Module overview: the small part of the tar format that the Docker archive
// API needs. `packTar` writes regular files. `unpackFirstFile` reads the first
// regular file from an archive that Docker returns.

const BLOCK = 512;

/** One regular file to write into a tar archive. */
export interface TarFile {
  /** Path inside the archive, without a leading `/`. */
  path: string;
  content: Uint8Array;
  mode: number;
  uid: number;
  gid: number;
}

function writeString(
  header: Buffer,
  value: string,
  offset: number,
  length: number,
) {
  header.write(value, offset, Math.min(Buffer.byteLength(value), length));
}

function writeOctal(
  header: Buffer,
  value: number,
  offset: number,
  length: number,
) {
  writeString(
    header,
    `${value.toString(8).padStart(length - 1, "0")}\0`,
    offset,
    length,
  );
}

function header(input: {
  name: string;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  type: string;
}): Buffer {
  const block = Buffer.alloc(BLOCK);
  writeString(block, input.name, 0, 100);
  writeOctal(block, input.mode & 0o7777, 100, 8);
  writeOctal(block, input.uid, 108, 8);
  writeOctal(block, input.gid, 116, 8);
  writeOctal(block, input.size, 124, 12);
  writeOctal(block, Math.floor(Date.now() / 1000), 136, 12);
  block.fill(" ", 148, 156);
  writeString(block, input.type, 156, 1);
  writeString(block, "ustar\0", 257, 6);
  writeString(block, "00", 263, 2);
  let checksum = 0;
  for (const byte of block) checksum += byte;
  writeString(block, `${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

function padding(size: number): Buffer {
  const remainder = size % BLOCK;
  return Buffer.alloc(remainder === 0 ? 0 : BLOCK - remainder);
}

/** A PAX record such as `30 path=some/long/name\n`. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body);
  length += String(length).length;
  if (String(length).length !== String(length - 1).length) length += 1;
  return Buffer.from(`${length}${body}`);
}

/** Write regular files into one uncompressed tar archive. */
export function packTar(files: TarFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    const content = Buffer.from(file.content);
    let name = file.path;
    if (Buffer.byteLength(name) > 99) {
      const pax = paxRecord("path", name);
      parts.push(
        header({ ...file, name: "PaxHeader", size: pax.length, type: "x" }),
        pax,
        padding(pax.length),
      );
      name = name.slice(-99);
    }
    parts.push(
      header({ ...file, name, size: content.length, type: "0" }),
      content,
      padding(content.length),
    );
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const text = block
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/\0.*$/s, "")
    .trim();
  return text ? Number.parseInt(text, 8) : 0;
}

/** Return the content of the first regular file in a tar archive. */
export function unpackFirstFile(archive: Buffer): Buffer | null {
  let offset = 0;
  while (offset + BLOCK <= archive.length) {
    const block = archive.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) return null;
    const size = readOctal(block, 124, 12);
    const type = String.fromCharCode(block[156] ?? 0);
    const start = offset + BLOCK;
    if (type === "0" || type === "\0") {
      return archive.subarray(start, start + size);
    }
    offset = start + size + padding(size).length;
  }
  return null;
}
