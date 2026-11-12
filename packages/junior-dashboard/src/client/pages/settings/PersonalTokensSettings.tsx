import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import {
  createdPersonalTokenSchema,
  personalTokenListSchema,
  type PersonalTokenMetadata,
} from "@sentry/junior/api/schema";
import { deleteDashboardResource, fetchDashboardJson, post } from "../../http";
import { getDashboardAgentName } from "../../agentName";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { InlineError } from "../../components/InlineError";
import { Card } from "../../components/layout/Card";
import { SettingsSection } from "./SettingsPageLayout";

const personalTokensQueryKey = ["dashboard", "personal-tokens"] as const;

/** Create and revoke personal API tokens for local clients. */
export function PersonalTokensSettings() {
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
  const canCreate = !loading && !busy && Boolean(name.trim());
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
    <SettingsSection
      anchor="api-tokens"
      description={
        <>
          Use a token to read {getDashboardAgentName()} APIs from a local agent
          or script. Tokens expire after 90 days.
        </>
      }
      title="API Tokens"
    >
      {createdToken ? (
        <div className="rounded-md border border-emerald-400/40 bg-emerald-400/5 p-3">
          <p className="mt-0 mb-2 text-sm font-semibold">
            Copy this token now. It won't be shown again.
          </p>
          <code className="block overflow-x-auto rounded-md bg-dashboard-ink p-2 text-xs text-emerald-300">
            {createdToken.token}
          </code>
          <Button
            variant="outline"
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
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canCreate || createTokenStarted.current) return;
            revokeTokenMutation.reset();
            createTokenStarted.current = true;
            createTokenMutation.mutate(name);
          }}
        >
          <Input
            aria-label="Token name"
            className="min-w-0 flex-1"
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
          <Button variant="outline" disabled={!canCreate} type="submit">
            Create token
          </Button>
        </form>
      )}

      {displayedError ? <InlineError>{displayedError}</InlineError> : null}

      <Card className="mb-0" variant="raised">
        {loading ? (
          <p className="m-0 p-5 text-sm text-dashboard-text-muted">
            Loading API tokens…
          </p>
        ) : tokens.length === 0 ? (
          <p className="m-0 p-5 text-sm text-dashboard-text-muted">
            No active API tokens.
          </p>
        ) : (
          <ul className="m-0 list-none divide-y divide-dashboard-border-subtle p-0">
            {tokens.map((token) => (
              <li className="flex items-center gap-3 px-5 py-4" key={token.id}>
                <KeyRound className="text-dashboard-accent" size={16} />
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate text-sm font-semibold">
                    {token.name}
                  </p>
                  <p className="mt-1 mb-0 text-xs text-dashboard-text-muted">
                    Ends in {token.tokenSuffix} · Expires{" "}
                    {new Date(token.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  aria-label={`Revoke ${token.name}`}
                  disabled={busy}
                  onClick={() => {
                    if (createTokenMutation.isError) {
                      createTokenMutation.reset();
                    }
                    revokeTokenMutation.mutate(token);
                  }}
                  size="icon"
                  variant="destructive"
                  type="button"
                >
                  <Trash2 size={16} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </SettingsSection>
  );
}
