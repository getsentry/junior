/**
 * The certificate authority of the recording proxy.
 *
 * The proxy intercepts HTTPS. It creates its own certificate authority when
 * it starts, and signs one certificate for each host when a client first
 * connects to that host. Clients must trust the authority certificate.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";

function openssl(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("openssl", args, (error, _stdout, stderr) => {
      if (error) reject(new Error(`openssl failed: ${stderr || error}`));
      else resolve();
    });
  });
}

/** A certificate authority that signs a certificate for each host. */
export interface CertificateAuthority {
  /** The PEM certificate that clients must trust. */
  caCert: string;
  /** The TLS context for a host. Signs its certificate on first use. */
  contextFor(host: string): Promise<tls.SecureContext>;
  /** Delete the keys and certificates. */
  close(): Promise<void>;
}

/** Create a certificate authority in a new temporary directory. */
export async function createCertificateAuthority(): Promise<CertificateAuthority> {
  const directory = await mkdtemp(path.join(tmpdir(), "recording-proxy-ca-"));
  const caKey = path.join(directory, "ca.key");
  const caCertFile = path.join(directory, "ca.crt");
  const hostKey = path.join(directory, "host.key");
  await openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    caCertFile,
    "-days",
    "7",
    "-subj",
    "/CN=Recording proxy CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  // All hosts share one key. Only their certificates differ.
  await openssl(["genrsa", "-out", hostKey, "2048"]);
  const hostKeyPem = await readFile(hostKey, "utf8");
  const contexts = new Map<string, Promise<tls.SecureContext>>();

  const sign = async (host: string): Promise<tls.SecureContext> => {
    const name = createHash("sha256").update(host).digest("hex").slice(0, 16);
    const csr = path.join(directory, `${name}.csr`);
    const extensions = path.join(directory, `${name}.ext`);
    const cert = path.join(directory, `${name}.crt`);
    const bare = host.replace(/^\[|\]$/g, "");
    const altName = isIP(bare) ? `IP:${bare}` : `DNS:${host}`;
    await writeFile(
      extensions,
      `subjectAltName=${altName}\nextendedKeyUsage=serverAuth\n`,
    );
    await openssl([
      "req",
      "-new",
      "-key",
      hostKey,
      "-subj",
      "/CN=Recording proxy host",
      "-out",
      csr,
    ]);
    await openssl([
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      caCertFile,
      "-CAkey",
      caKey,
      "-set_serial",
      `0x${randomBytes(8).toString("hex")}`,
      "-days",
      "7",
      "-extfile",
      extensions,
      "-out",
      cert,
    ]);
    return tls.createSecureContext({
      cert: await readFile(cert, "utf8"),
      key: hostKeyPem,
    });
  };

  return {
    caCert: await readFile(caCertFile, "utf8"),
    contextFor(host) {
      let context = contexts.get(host);
      if (!context) {
        context = sign(host);
        contexts.set(host, context);
      }
      return context;
    },
    close: () => rm(directory, { force: true, recursive: true }),
  };
}
