export interface RuntimeMetadata {
  version?: string;
}

function toOptionalTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getRuntimeMetadata(): RuntimeMetadata {
  return {
    version: toOptionalTrimmed(process.env.VERCEL_GIT_COMMIT_SHA)
  };
}
