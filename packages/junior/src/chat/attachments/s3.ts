import { AwsClient } from "aws4fetch";
import { toOptionalTrimmed } from "@/chat/optional-string";
import { rangeHeader, type AttachmentStorage } from "./storage";

/** Settings for an S3-compatible object store. */
export interface S3StorageConfig {
  accessKeyId: string;
  bucket: string;
  /** Base URL of the S3 API. Objects use path-style URLs under it. */
  endpoint: string;
  region: string;
  secretAccessKey: string;
}

function readRequiredSetting(env: NodeJS.ProcessEnv, name: string): string {
  const value = toOptionalTrimmed(env[name]);
  if (value === undefined) {
    throw new Error(
      `${name} is required when JUNIOR_ATTACHMENT_STORAGE_PROVIDER is s3`,
    );
  }
  return value;
}

/** Read S3 settings from `JUNIOR_S3_*` environment variables. */
export function readS3StorageConfig(env: NodeJS.ProcessEnv): S3StorageConfig {
  return {
    accessKeyId: readRequiredSetting(env, "JUNIOR_S3_ACCESS_KEY_ID"),
    bucket: readRequiredSetting(env, "JUNIOR_S3_BUCKET"),
    endpoint: readRequiredSetting(env, "JUNIOR_S3_ENDPOINT"),
    region: toOptionalTrimmed(env.JUNIOR_S3_REGION) ?? "us-east-1",
    secretAccessKey: readRequiredSetting(env, "JUNIOR_S3_SECRET_ACCESS_KEY"),
  };
}

/**
 * Path-style object URL. Local S3 servers and AWS S3 both accept it.
 *
 * URL parsing removes `.` and `..` segments, also in `%2e` form. A key with
 * such a segment would address a different object, so reject it.
 */
function objectUrl(config: S3StorageConfig, key: string): string {
  const endpoint = config.endpoint.replace(/\/+$/, "");
  const segments = key.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("S3 object keys cannot contain . or .. path segments");
  }
  const path = segments.map(encodeURIComponent).join("/");
  return `${endpoint}/${encodeURIComponent(config.bucket)}/${path}`;
}

/**
 * Read a small S3 response body to the end so the connection is released.
 *
 * Error and empty bodies are small. `body.cancel()` can hang under the test
 * HTTP interceptor, so read the body instead.
 */
async function drain(response: Response): Promise<void> {
  await response.arrayBuffer();
}

/** Throw on a failed S3 response, and release the response body. */
async function expectOk(response: Response, operation: string): Promise<void> {
  await drain(response);
  if (!response.ok) {
    // Do not put the key or the S3 error body in the message. Both can
    // contain user filenames.
    throw new Error(`S3 ${operation} failed with status ${response.status}`);
  }
}

/** Store private conversation attachments in an S3-compatible bucket. */
export function createS3AttachmentStorage(
  config: S3StorageConfig,
): AttachmentStorage {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    region: config.region,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
  });
  // aws4fetch retries with the same body, but a stream can be read only
  // once. The attachment store retries a write with a fresh body instead.
  const writeClient = new AwsClient({
    accessKeyId: config.accessKeyId,
    region: config.region,
    retries: 0,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
  });
  return {
    provider: "s3",
    async put(input) {
      const response = await writeClient.fetch(objectUrl(config, input.key), {
        body: input.body,
        headers: {
          // A single S3 PUT needs the length before the body. A stream
          // cannot be hashed before it is sent, so the payload is unsigned.
          "content-length": String(input.bytes),
          "content-type": input.contentType,
          "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
        },
        method: "PUT",
      });
      await expectOk(response, "put");
    },
    async createUploadTarget(input) {
      const url = new URL(objectUrl(config, input.key));
      url.searchParams.set(
        "X-Amz-Expires",
        String(Math.max(1, Math.ceil((input.expiresAtMs - Date.now()) / 1000))),
      );
      const browserHeaders = {
        "content-type": input.contentType,
        // Write the key once. A sent file cannot change after the check.
        "if-none-match": "*",
      };
      // Sign the size and type headers too. S3 then rejects a PUT of any
      // other size or type. The browser sends `content-length` itself.
      const signed = await client.sign(url.toString(), {
        aws: { allHeaders: true, signQuery: true },
        headers: { ...browserHeaders, "content-length": String(input.bytes) },
        method: "PUT",
      });
      return {
        headers: browserHeaders,
        method: "PUT",
        url: signed.url,
      };
    },
    async get(key, range) {
      const response = await client.fetch(
        objectUrl(config, key),
        range ? { headers: { range: rangeHeader(range) } } : undefined,
      );
      if (response.status === 404) {
        await drain(response);
        return null;
      }
      if (!response.ok) {
        await expectOk(response, "get");
      }
      // A server that ignores the range sends the whole object with 200.
      if (range && response.status !== 206) {
        await drain(response);
        throw new Error(
          `S3 get ignored the byte range with status ${response.status}`,
        );
      }
      return response.body;
    },
    async delete(keys) {
      await Promise.all(
        keys.map(async (key) => {
          const response = await client.fetch(objectUrl(config, key), {
            method: "DELETE",
          });
          // S3 returns 204 for a missing key. Some local servers return 404.
          if (response.status === 404) {
            await drain(response);
            return;
          }
          await expectOk(response, "delete");
        }),
      );
    },
  };
}
