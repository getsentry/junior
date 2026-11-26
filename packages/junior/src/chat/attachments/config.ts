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
function readS3StorageConfig(env: NodeJS.ProcessEnv): S3StorageConfig {
  return {
    accessKeyId: readRequiredSetting(env, "JUNIOR_S3_ACCESS_KEY_ID"),
    bucket: readRequiredSetting(env, "JUNIOR_S3_BUCKET"),
    endpoint: readRequiredSetting(env, "JUNIOR_S3_ENDPOINT"),
    region: toOptionalTrimmed(env["JUNIOR_S3_REGION"]) ?? "us-east-1",
    secretAccessKey: readRequiredSetting(env, "JUNIOR_S3_SECRET_ACCESS_KEY"),
  };
}

/** Object storage for attachments and public artifacts. */
export type AttachmentStorageConfig =
  | { provider: "vercel-blob" }
  | { provider: "s3"; s3: S3StorageConfig }
  | { provider: "memory" };

/** Read attachment storage settings from environment variables. */
export function readAttachmentStorageConfig(
  env: NodeJS.ProcessEnv,
): AttachmentStorageConfig {
  const provider =
    toOptionalTrimmed(env["JUNIOR_ATTACHMENT_STORAGE_PROVIDER"]) ??
    "vercel-blob";
  switch (provider) {
    case "vercel-blob":
    case "memory":
      return { provider };
    case "s3":
      return { provider, s3: readS3StorageConfig(env) };
    default:
      throw new Error(
        "JUNIOR_ATTACHMENT_STORAGE_PROVIDER must be vercel-blob, s3, or memory",
      );
  }
}
