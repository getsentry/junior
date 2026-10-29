import { AwsClient } from "aws4fetch";
import { toOptionalTrimmed } from "@/chat/optional-string";
import type { AttachmentStorage } from "./storage";

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

/** Path-style object URL. Local S3 servers and AWS S3 both accept it. */
function objectUrl(config: S3StorageConfig, key: string): string {
  const endpoint = config.endpoint.replace(/\/+$/, "");
  const path = key.split("/").map(encodeURIComponent).join("/");
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
  return {
    provider: "s3",
    async put(input) {
      const response = await client.fetch(objectUrl(config, input.key), {
        // fetch types reject Buffer. Copy into a plain Uint8Array.
        body: new Uint8Array(input.body),
        headers: { "content-type": input.contentType },
        method: "PUT",
      });
      await expectOk(response, "put");
    },
    async get(key) {
      const response = await client.fetch(objectUrl(config, key));
      if (response.status === 404) {
        await drain(response);
        return null;
      }
      if (!response.ok) {
        await expectOk(response, "get");
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
