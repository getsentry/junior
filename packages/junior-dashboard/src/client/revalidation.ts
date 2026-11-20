import type { QueryFunctionContext } from "@tanstack/react-query";
import { CONTENT_VERSION_HEADER } from "@sentry/junior/api/schema";
import type { ZodType } from "zod";
import { readDashboardResponse } from "./http";
import { readResponseJson } from "./sentry";

/**
 * Read cached data again with the version token of the copy it holds. While
 * the content is unchanged, the server answers an empty 304 and the cached
 * copy stands. Otherwise `read` gets the response and its new token, and
 * stores the token where its query keeps it.
 */
export async function readRevalidated<T>(
  request: { header: string; path: string; signal?: AbortSignal | undefined },
  cached: { data: T; version: string | undefined } | undefined,
  read: (response: Response, version: string | undefined) => Promise<T>,
): Promise<T> {
  const response = await readDashboardResponse(
    request.path,
    request.signal,
    cached?.version ? { [request.header]: cached.version } : undefined,
  );
  if (response.status === 304 && cached) return cached.data;
  return read(response, response.headers.get(request.header) ?? undefined);
}

/**
 * Drop the version token of cached data that this client patched. The patch
 * is not in the body that the token names, so the next read must get the
 * whole body, not a 304 that keeps the patch.
 */
export function withoutVersion<T, K extends keyof T>(
  data: T,
  key: K,
): Omit<T, K> {
  const { [key]: _version, ...rest } = data;
  return rest;
}

/** A read that the server revalidates on content, with its token. */
export type ContentVersioned<T> = T & { contentVersion?: string };

/**
 * Build the query function of a read that `revalidateContent` covers on the
 * server. The token stays on the cached data as `contentVersion`.
 */
export function revalidatedJsonQuery<T extends object>(
  schema: ZodType<T>,
  path: string,
) {
  return ({
    client,
    queryKey,
    signal,
  }: QueryFunctionContext): Promise<ContentVersioned<T>> => {
    const cached = client.getQueryData<ContentVersioned<T>>(queryKey);
    return readRevalidated(
      { header: CONTENT_VERSION_HEADER, path, signal },
      cached && { data: cached, version: cached.contentVersion },
      async (response, contentVersion) => {
        const data = await readResponseJson(response, schema);
        return contentVersion ? { ...data, contentVersion } : data;
      },
    );
  };
}
