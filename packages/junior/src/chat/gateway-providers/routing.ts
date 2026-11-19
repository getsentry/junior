/**
 * The "Enabled providers" admin setting: which upstream providers AI Gateway
 * may route Junior's chat calls to.
 *
 * AI Gateway can serve one model from several providers, each with its own
 * prompt cache. An Admin can keep calls on fewer providers so they stay on
 * one cache. Calls then fail instead of falling back when those providers
 * are down. By default every provider is enabled and no filter is sent.
 */
import type { StateAdapter } from "chat";
import * as z from "zod";
import { isRecord } from "@/chat/coerce";
import { logWarn } from "@/chat/logging";
import type { Api, Model, StreamOptions } from "@/chat/pi/sdk";
import { createCache } from "@/chat/state/cache";
import { gatewayOnlyProviders } from "./rule";

const ENABLED_PROVIDERS_KEY = "junior:gateway:enabled_providers";
const MODEL_ENDPOINTS_URL = "https://ai-gateway.vercel.sh/v1/models";
const SERVED_PROVIDERS_CACHE_NAMESPACE = "gateway-served-providers";
const SERVED_PROVIDERS_TTL_MS = 60 * 60 * 1000;
const ENDPOINTS_TIMEOUT_MS = 5_000;
// The endpoints list names Claude on Vertex `vertexAnthropic`, but `only`
// takes the provider slug `vertex`.
const PROVIDER_SLUGS: Readonly<Record<string, string>> = {
  vertexAnthropic: "vertex",
};

const enabledProvidersSchema = z.array(z.string());
const modelEndpointsSchema = z.object({
  data: z.object({
    endpoints: z.array(z.object({ provider_name: z.string() })),
  }),
});

/** Read the enabled providers. Null means every provider is enabled. */
export async function readEnabledProviders(
  state: StateAdapter,
): Promise<string[] | null> {
  const stored = await state.get(ENABLED_PROVIDERS_KEY);
  return stored === null ? null : enabledProvidersSchema.parse(stored);
}

/** Save the enabled providers. Null enables every provider again. */
export async function saveEnabledProviders(
  state: StateAdapter,
  enabled: readonly string[] | null,
): Promise<void> {
  if (enabled === null) {
    await state.delete(ENABLED_PROVIDERS_KEY);
    return;
  }
  await state.set(ENABLED_PROVIDERS_KEY, [...new Set(enabled)].sort());
}

async function fetchServedProviders(modelId: string): Promise<string[]> {
  const path = modelId.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${MODEL_ENDPOINTS_URL}/${path}/endpoints`, {
    signal: AbortSignal.timeout(ENDPOINTS_TIMEOUT_MS),
  });
  // The gateway does not know the model, so no provider serves it.
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`AI Gateway endpoints returned ${response.status}`);
  }
  const { data } = modelEndpointsSchema.parse(await response.json());
  const slugs = data.endpoints.map(
    ({ provider_name }) => PROVIDER_SLUGS[provider_name] ?? provider_name,
  );
  return [...new Set(slugs)];
}

/** List the providers that AI Gateway can route one model to. */
export async function readServedProviders(
  state: StateAdapter,
  modelId: string,
): Promise<string[]> {
  return await createCache(state, SERVED_PROVIDERS_CACHE_NAMESPACE).getOrLoad(
    modelId,
    async () => ({
      value: await fetchServedProviders(modelId),
      ttlMs: SERVED_PROVIDERS_TTL_MS,
    }),
  );
}

// The AI Gateway `only` list for one model call, if any.
async function gatewayOnlyForModel(
  modelId: string,
): Promise<string[] | undefined> {
  // Imported here: the state adapter reads the chat config, which imports
  // the Pi client that wraps its streams with this module.
  const { getStateAdapter } = await import("@/chat/state/adapter");
  const state = getStateAdapter();
  const enabled = await readEnabledProviders(state);
  if (enabled === null) return undefined;
  let served: string[];
  try {
    served = await readServedProviders(state, modelId);
  } catch (error) {
    // Unfiltered is the default routing, so a failed lookup never breaks a
    // call. The call may reach a provider with a cold cache.
    logWarn("ai.gateway.served_providers.failed", {
      "gen_ai.request.model": modelId,
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  return gatewayOnlyProviders(enabled, served);
}

function withGatewayOnly(payload: unknown, only: string[]): unknown {
  if (!isRecord(payload)) {
    throw new Error("Messages request body is not an object");
  }
  const providerOptions = isRecord(payload["providerOptions"])
    ? payload["providerOptions"]
    : {};
  const gateway = isRecord(providerOptions["gateway"])
    ? providerOptions["gateway"]
    : {};
  return {
    ...payload,
    providerOptions: { ...providerOptions, gateway: { ...gateway, only } },
  };
}

/**
 * Wrap a Pi Messages stream so each request body carries the `only` list of
 * the enabled providers. AI Gateway reads it from
 * `providerOptions.gateway.only` in the Messages API body.
 */
export function withEnabledGatewayProviders<
  TModel extends Pick<Model<"anthropic-messages">, "id">,
  TContext,
  TOptions extends StreamOptions,
  TResult,
>(
  stream: (model: TModel, context: TContext, options?: TOptions) => TResult,
): (model: TModel, context: TContext, options?: TOptions) => TResult {
  return (model, context, options) =>
    // Keep every option that the caller passed. It can pass none.
    stream(
      model,
      context,
      Object.assign({}, options, {
        onPayload: async (payload: unknown, payloadModel: Model<Api>) => {
          const replaced = await options?.onPayload?.(payload, payloadModel);
          const only = await gatewayOnlyForModel(model.id);
          return only ? withGatewayOnly(replaced ?? payload, only) : replaced;
        },
      }),
    );
}
