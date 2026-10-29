import { toOptionalTrimmed } from "@/chat/optional-string";

/** Settings for an S3-compatible object store. */
export interface S3StorageConfig {
  accessKeyId: string;
  bucket: string;
  /** Base URL of the S3 API. Objects use path-style URLs under it. */
  endpoint: string;
  region: string;
  secretAccessKey: string;
}

/** Object storage for attachments and public artifacts. */
export type AttachmentStorageConfig =
  | { provider: "vercel-blob" }
  | { provider: "s3"; s3: S3StorageConfig };

function readRequiredS3Setting(env: NodeJS.ProcessEnv, name: string): string {
  const value = toOptionalTrimmed(env[name]);
  if (value === undefined) {
    throw new Error(
      `${name} is required when JUNIOR_ATTACHMENT_STORAGE_PROVIDER is s3`,
    );
  }
  return value;
}

/** Read attachment storage settings from environment variables. */
export function readAttachmentStorageConfig(
  env: NodeJS.ProcessEnv,
): AttachmentStorageConfig {
  const provider =
    toOptionalTrimmed(env.JUNIOR_ATTACHMENT_STORAGE_PROVIDER) ?? "vercel-blob";
  if (provider === "vercel-blob") {
    return { provider };
  }
  if (provider !== "s3") {
    throw new Error(
      "JUNIOR_ATTACHMENT_STORAGE_PROVIDER must be vercel-blob or s3",
    );
  }
  return {
    provider,
    s3: {
      accessKeyId: readRequiredS3Setting(env, "JUNIOR_S3_ACCESS_KEY_ID"),
      bucket: readRequiredS3Setting(env, "JUNIOR_S3_BUCKET"),
      endpoint: readRequiredS3Setting(env, "JUNIOR_S3_ENDPOINT"),
      region: toOptionalTrimmed(env.JUNIOR_S3_REGION) ?? "us-east-1",
      secretAccessKey: readRequiredS3Setting(
        env,
        "JUNIOR_S3_SECRET_ACCESS_KEY",
      ),
    },
  };
}
