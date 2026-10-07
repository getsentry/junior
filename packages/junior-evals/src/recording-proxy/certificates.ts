/**
 * The certificate authority of the recording proxy.
 *
 * The proxy intercepts HTTPS. It creates its own certificate authority when
 * it starts, and signs one certificate for each host when a client first
 * connects to that host. Clients must trust the authority certificate.
 *
 * Like the server, this file uses only Node built-ins and the `openssl`
 * command.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import tls from "node:tls";

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, _stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${stderr || error}`));
      else resolve();
    });
  });
}

/**
 * Create a certificate authority, and sign one certificate for each host
 * when a client first connects to it.
 */
export async function createCertificates(directory: string) {
  const caKey = path.join(directory, "ca.key");
  const caCertPath = path.join(directory, "ca.crt");
  const hostKey = path.join(directory, "host.key");
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    caCertPath,
    "-days",
    "7",
    "-subj",
    "/CN=Recording proxy CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  await run("openssl", ["genrsa", "-out", hostKey, "2048"]);
  const hostKeyPem = await readFile(hostKey, "utf8");
  const contexts = new Map<string, Promise<tls.SecureContext>>();

  const sign = async (host: string): Promise<tls.SecureContext> => {
    const name = createHash("sha256").update(host).digest("hex").slice(0, 16);
    const csr = path.join(directory, `${name}.csr`);
    const extensions = path.join(directory, `${name}.ext`);
    const cert = path.join(directory, `${name}.crt`);
    const altName = isIP(host.replace(/^\[|\]$/g, ""))
      ? `IP:${host.replace(/^\[|\]$/g, "")}`
      : `DNS:${host}`;
    await writeFile(
      extensions,
      `subjectAltName=${altName}\nextendedKeyUsage=serverAuth\n`,
    );
    await run("openssl", [
      "req",
      "-new",
      "-key",
      hostKey,
      "-subj",
      "/CN=Recording proxy host",
      "-out",
      csr,
    ]);
    await run("openssl", [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      caCertPath,
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
    caCert: await readFile(caCertPath, "utf8"),
    contextFor(host: string): Promise<tls.SecureContext> {
      let context = contexts.get(host);
      if (!context) {
        context = sign(host);
        contexts.set(host, context);
      }
      return context;
    },
  };
}
