import type {
  InfiniteData,
  QueryFunctionContext,
  QueryKey,
} from "@tanstack/react-query";
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

function readContentVersioned<T extends object>(
  schema: ZodType<T>,
  request: { path: string; signal: AbortSignal },
  cached: ContentVersioned<T> | undefined,
): Promise<ContentVersioned<T>> {
  return readRevalidated(
    { header: CONTENT_VERSION_HEADER, ...request },
    cached && { data: cached, version: cached.contentVersion },
    async (response, contentVersion) => {
      const data = await readResponseJson(response, schema);
      return contentVersion ? { ...data, contentVersion } : data;
    },
  );
}

/**
 * Build the query function of a read that `revalidateContent` covers on the
 * server. The token stays on the cached data as `contentVersion`.
 */
export function revalidatedJsonQuery<T extends object>(
  schema: ZodType<T>,
  path: string,
) {
  return ({ client, queryKey, signal }: QueryFunctionContext) =>
    readContentVersioned(
      schema,
      { path, signal },
      client.getQueryData<ContentVersioned<T>>(queryKey),
    );
}

/**
 * Build the page query function of an infinite read that the server
 * revalidates on content. A refetch reads every loaded page again, and each
 * page sends the token of the cached page with the same page param, so an
 * unchanged page comes back with no body.
 */
export function revalidatedPageQuery<T extends object>(
  schema: ZodType<T>,
  path: (pageParam: string | undefined) => string,
) {
  return ({
    client,
    pageParam,
    queryKey,
    signal,
  }: QueryFunctionContext<QueryKey, string | undefined>) => {
    const cached =
      client.getQueryData<
        InfiniteData<ContentVersioned<T>, string | undefined>
      >(queryKey);
    const index = cached?.pageParams.indexOf(pageParam) ?? -1;
    return readContentVersioned(
      schema,
      { path: path(pageParam), signal },
      index >= 0 ? cached?.pages[index] : undefined,
    );
  };
}
