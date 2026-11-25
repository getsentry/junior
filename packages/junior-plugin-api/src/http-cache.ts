/** One provider GET that a plugin sends with a credential it holds. */
export interface PluginHttpCacheRequest {
  /**
   * The credential that `send` uses, such as `installation:123`. An entry
   * of one scope never serves a request of another scope.
   */
  scope: string;
  /**
   * How long an entry serves without a request. With `0`, every read asks
   * the provider, with the entry's `ETag` or `Last-Modified`, so an
   * unchanged response costs only a `304 Not Modified`.
   */
  ttlMs: number;
  url: string;
  /** Send the GET with these validator headers added. */
  send(headers: Record<string, string>): Promise<Response>;
}

/**
 * Junior's HTTP cache, for provider reads that do not go through egress,
 * such as a webhook read with a token that the plugin minted. Egress reads
 * of object links use the same cache.
 */
export interface PluginHttpCache {
  /**
   * Return the response of one GET. A failed read of the cache is a miss,
   * so it never fails the provider read.
   */
  fetch(request: PluginHttpCacheRequest): Promise<Response>;
}
