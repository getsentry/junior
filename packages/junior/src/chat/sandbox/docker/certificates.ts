import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Module overview: the dev certificate authority for Docker sandbox egress.
//
// The egress proxy decrypts TLS only for credentialed and trace domains. It
// shows the sandbox a leaf certificate for the requested host, signed by a CA
// that each sandbox trusts. Node can sign but not build X.509 certificates, so
// this module writes the few DER structures that a CA and a TLS server
// certificate need.

const CA_COMMON_NAME = "Junior Docker Sandbox Egress CA";
const CA_VALID_DAYS = 3650;
/** Clients reject long-lived leaf certificates, so keep them short. */
const LEAF_VALID_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

const OID = {
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  authorityKeyIdentifier: "2.5.29.35",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
};

/** The CA key and certificate that sign leaf certificates. */
export interface EgressCa {
  certPem: string;
  key: KeyObject;
  keyId: Buffer;
  subject: Buffer;
}

function tlv(tag: number, content: Buffer): Buffer {
  const length = content.length;
  if (length < 0x80) {
    return Buffer.concat([Buffer.from([tag, length]), content]);
  }
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return Buffer.concat([
    Buffer.from([tag, 0x80 | bytes.length, ...bytes]),
    content,
  ]);
}

const sequence = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));
const octetString = (value: Buffer) => tlv(0x04, value);
const bitString = (value: Buffer) =>
  tlv(0x03, Buffer.concat([Buffer.from([0]), value]));
const explicit = (index: number, value: Buffer) => tlv(0xa0 + index, value);
const booleanTrue = () => tlv(0x01, Buffer.from([0xff]));

function integer(value: Buffer): Buffer {
  const positive =
    (value[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value;
  return tlv(0x02, positive);
}

function oid(value: string): Buffer {
  const [first = 0, second = 0, ...rest] = value.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const part of rest) {
    const chunk = [part & 0x7f];
    for (let remaining = part >> 7; remaining > 0; remaining >>= 7) {
      chunk.unshift((remaining & 0x7f) | 0x80);
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`))
    : tlv(0x18, Buffer.from(`${iso}Z`));
}

function name(commonName: string): Buffer {
  return sequence(
    set(sequence(oid(OID.commonName), tlv(0x0c, Buffer.from(commonName)))),
  );
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(
    oid(id),
    ...(critical ? [booleanTrue()] : []),
    octetString(value),
  );
}

function publicKeyInfo(key: KeyObject): Buffer {
  return createPublicKey(key).export({ type: "spki", format: "der" });
}

function keyIdentifier(key: KeyObject): Buffer {
  return createHash("sha1").update(publicKeyInfo(key)).digest();
}

function certificate(input: {
  subject: Buffer;
  issuer: Buffer;
  publicKey: KeyObject;
  signingKey: KeyObject;
  validDays: number;
  extensions: Buffer[];
}): string {
  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const algorithm = sequence(oid(OID.ecdsaWithSha256));
  const now = Date.now();
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    input.issuer,
    sequence(
      time(new Date(now - DAY_MS)),
      time(new Date(now + input.validDays * DAY_MS)),
    ),
    input.subject,
    publicKeyInfo(input.publicKey),
    explicit(3, sequence(...input.extensions)),
  );
  const signature = sign("sha256", tbs, {
    key: input.signingKey,
    dsaEncoding: "der",
  });
  const der = sequence(tbs, algorithm, bitString(signature));
  const base64 = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN CERTIFICATE-----\n${base64.trim()}\n-----END CERTIFICATE-----\n`;
}

function newKey(): KeyObject {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
}

function createCa(): { certPem: string; keyPem: string } {
  const key = newKey();
  const subject = name(CA_COMMON_NAME);
  const certPem = certificate({
    subject,
    issuer: subject,
    publicKey: key,
    signingKey: key,
    validDays: CA_VALID_DAYS,
    extensions: [
      extension(OID.basicConstraints, true, sequence(booleanTrue())),
      // keyCertSign and cRLSign.
      extension(OID.keyUsage, true, tlv(0x03, Buffer.from([1, 0x06]))),
      extension(
        OID.subjectKeyIdentifier,
        false,
        octetString(keyIdentifier(key)),
      ),
    ],
  });
  const keyPem = key.export({ type: "pkcs8", format: "pem" }).toString();
  return { certPem, keyPem };
}

async function readOrCreate(
  file: string,
  create: () => string,
): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await fs.writeFile(file, create(), { flag: "wx", mode: 0o600 });
  } catch (error) {
    // Another process created it first.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return await fs.readFile(file, "utf8");
}

/**
 * Load this machine's egress CA from `dir`, or create it.
 *
 * Every Junior process on the machine shares one CA, so a sandbox trusts the
 * proxy of any process that applies its network policy.
 */
export async function loadEgressCa(dir: string): Promise<EgressCa> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(dir, "egress-ca-key.pem");
  const certFile = path.join(dir, "egress-ca.pem");
  let created: { certPem: string; keyPem: string } | undefined;
  const make = () => (created ??= createCa());
  const keyPem = await readOrCreate(keyFile, () => make().keyPem);
  const certPem = await readOrCreate(certFile, () => {
    if (!created) {
      throw new Error(`${keyFile} exists without ${certFile}. Delete it.`);
    }
    return created.certPem;
  });
  const key = createPrivateKey(keyPem);
  return {
    certPem,
    key,
    keyId: keyIdentifier(key),
    subject: name(CA_COMMON_NAME),
  };
}

/** Issue a TLS server certificate for one host, signed by the egress CA. */
export function issueLeafCertificate(
  ca: EgressCa,
  host: string,
  key: KeyObject,
): string {
  return certificate({
    subject: name(host),
    issuer: ca.subject,
    publicKey: key,
    signingKey: ca.key,
    validDays: LEAF_VALID_DAYS,
    extensions: [
      extension(OID.basicConstraints, true, sequence()),
      // digitalSignature.
      extension(OID.keyUsage, true, tlv(0x03, Buffer.from([7, 0x80]))),
      extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
      extension(
        OID.subjectAltName,
        false,
        sequence(tlv(0x82, Buffer.from(host))),
      ),
      extension(
        OID.authorityKeyIdentifier,
        false,
        sequence(tlv(0x80, ca.keyId)),
      ),
    ],
  });
}

/** Create the private key that this process uses for every leaf certificate. */
export function createLeafKey(): KeyObject {
  return newKey();
}
