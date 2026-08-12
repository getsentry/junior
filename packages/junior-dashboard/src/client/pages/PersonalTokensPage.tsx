import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import {
  createdPersonalTokenSchema,
  personalTokenListSchema,
  type PersonalTokenMetadata,
} from "@sentry/junior/api/schema";
import { deleteDashboardResource, fetchDashboardJson, post } from "../http";
import { dashboardContainerClass } from "../styles";
import { getDashboardAgentName } from "../agentName";
import { Button } from "../components/Button";

const personalTokensQueryKey = ["dashboard", "personal-tokens"] as const;

/** Create and revoke personal API tokens for local clients. */
export function PersonalTokensPage() {
  const queryClient = useQueryClient();
  const createTokenStarted = useRef(false);
  const [name, setName] = useState("Local agent");
  const cancelTokenListRefetch = () =>
    queryClient.cancelQueries({
      exact: true,
      queryKey: personalTokensQueryKey,
    });
  const tokensQuery = useQuery({
    queryKey: personalTokensQueryKey,
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        personalTokenListSchema,
        "/api/personal-tokens",
        signal,
      ),
    retry: false,
  });
  const createTokenMutation = useMutation({
    gcTime: 0,
    mutationFn: (tokenName: string) =>
      post(createdPersonalTokenSchema, "/api/personal-tokens", {
        name: tokenName,
      }),
    onMutate: () => cancelTokenListRefetch(),
    onSuccess: async (created) => {
      const { token: _token, ...metadata } = created;
      await cancelTokenListRefetch();
      queryClient.setQueryData<{ tokens: PersonalTokenMetadata[] }>(
        personalTokensQueryKey,
        (current) => ({
          tokens: [
            metadata,
            ...(current?.tokens ?? []).filter(
              (token) => token.id !== metadata.id,
            ),
          ],
        }),
      );
    },
    onSettled: () => {
      createTokenStarted.current = false;
    },
  });
  const revokeTokenMutation = useMutation({
    mutationFn: (token: PersonalTokenMetadata) =>
      deleteDashboardResource(
        `/api/personal-tokens/${encodeURIComponent(token.id)}`,
      ),
    onMutate: () => cancelTokenListRefetch(),
    onSuccess: async (_result, token) => {
      await cancelTokenListRefetch();
      queryClient.setQueryData<{ tokens: PersonalTokenMetadata[] }>(
        personalTokensQueryKey,
        (current) => ({
          tokens: (current?.tokens ?? []).filter(
            (item) => item.id !== token.id,
          ),
        }),
      );
      if (createTokenMutation.data?.id === token.id) {
        createTokenMutation.reset();
      }
    },
  });
  const createdToken = createTokenMutation.data;
  const tokens = tokensQuery.data?.tokens ?? [];
  const loading = tokensQuery.isPending;
  const busy = createTokenMutation.isPending || revokeTokenMutation.isPending;
  const displayedError =
    (createTokenMutation.isError
      ? "Could not create the API token. Try again."
      : revokeTokenMutation.isError
        ? "Could not revoke the API token. Try again."
        : undefined) ??
    (!tokensQuery.data && tokensQuery.isError
      ? "Could not load API tokens. Try again."
      : undefined);

  return (
    <div className={`${dashboardContainerClass} px-4 py-8 md:px-8`}>
      <section className="mx-auto w-full max-w-3xl">
        <h1 className="m-0 text-2xl font-bold">Personal API Tokens</h1>
        <p className="mt-2 mb-0 max-w-2xl text-sm text-dashboard-text-muted">
          Use a token to read {getDashboardAgentName()} APIs from a local agent
          or script. Tokens expire after 90 days.
        </p>

        <div className="mt-6 rounded-lg border border-dashboard-border-emphasis bg-dashboard-surface-raised p-5">
          {createdToken ? (
            <div className="mt-5 rounded border border-emerald-400/40 bg-emerald-400/5 p-3">
              <p className="mt-0 mb-2 text-sm font-semibold">
                Copy this token now. It won't be shown again.
              </p>
              <code className="block overflow-x-auto rounded bg-dashboard-ink p-2 text-xs text-emerald-300">
                {createdToken.token}
              </code>
              <Button
                className="mt-3"
                onClick={() => {
                  createTokenMutation.reset();
                  setName("Local agent");
                }}
              >
                Create another token
              </Button>
            </div>
          ) : (
            <div className="mt-5 flex gap-2">
              <input
                aria-label="Token name"
                className="min-w-0 flex-1 rounded border border-dashboard-border-emphasis bg-dashboard-ink px-3 py-2 text-sm text-dashboard-text"
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
              <Button
                disabled={loading || busy || !name.trim()}
                onClick={() => {
                  if (createTokenStarted.current) return;
                  revokeTokenMutation.reset();
                  createTokenStarted.current = true;
                  createTokenMutation.mutate(name);
                }}
              >
                Create token
              </Button>
            </div>
          )}

          {displayedError ? (
            <p className="mb-0 text-sm text-rose-300">{displayedError}</p>
          ) : null}

          <div className="mt-5 space-y-2">
            {loading ? (
              <p className="text-sm text-dashboard-text-muted">
                Loading API tokens…
              </p>
            ) : tokens.length === 0 ? (
              <p className="text-sm text-dashboard-text-muted">
                No active API tokens.
              </p>
            ) : (
              tokens.map((token) => (
                <div
                  className="flex items-center gap-3 rounded border border-dashboard-border-strong p-3"
                  key={token.id}
                >
                  <KeyRound className="text-dashboard-focus" size={16} />
                  <div className="min-w-0 flex-1">
                    <p className="m-0 truncate text-sm font-semibold">
                      {token.name}
                    </p>
                    <p className="mt-1 mb-0 text-xs text-dashboard-text-muted">
                      Ends in {token.tokenSuffix} · Expires{" "}
                      {new Date(token.expiresAt).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    aria-label={`Revoke ${token.name}`}
                    className="cursor-pointer border-0 bg-transparent p-1 text-dashboard-text-muted hover:text-rose-300"
                    disabled={busy}
                    onClick={() => {
                      if (createTokenMutation.isError) {
                        createTokenMutation.reset();
                      }
                      revokeTokenMutation.mutate(token);
                    }}
                    type="button"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
