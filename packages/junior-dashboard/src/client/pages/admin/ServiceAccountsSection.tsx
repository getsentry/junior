import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import type { z } from "zod";
import {
  disconnectServiceAccountResponseSchema,
  serviceAccountListSchema,
  startServiceAccountSignInResponseSchema,
  type serviceAccountSchema,
} from "@sentry/junior/api/schema";
import { getDashboardAgentName } from "../../agentName";
import { Button } from "../../components/ui/button";
import { InlineError } from "../../components/InlineError";
import { StatusChip } from "../../components/StatusChip";
import { Card } from "../../components/layout/Card";
import { formatRelativeTime } from "../../format";
import { del, fetchDashboardJson, post } from "../../http";

type ServiceAccount = z.infer<typeof serviceAccountSchema>;

const serviceAccountsQueryKey = ["dashboard", "service-accounts"] as const;

function serviceAccountPath(provider: string): string {
  return `/api/service-accounts/${encodeURIComponent(provider)}`;
}

/** Load the plugins that support a service account, with their status. */
export function useServiceAccounts() {
  return useQuery({
    queryKey: serviceAccountsQueryKey,
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        serviceAccountListSchema,
        "/api/service-accounts",
        signal,
      ),
    // OAuth finishes in another tab. Refresh when the admin returns.
    refetchOnWindowFocus: true,
    retry: false,
  });
}

function statusText(account: ServiceAccount): string {
  const usage = !account.userOAuth
    ? `Everyone uses this account. People cannot connect their own ${account.displayName} account.`
    : `People who have not connected their own ${account.displayName} account use this account.`;
  if (!account.connected) {
    const blocked = !account.userOAuth
      ? ` ${account.displayName} is not available until you connect it.`
      : "";
    return `Not connected.${blocked} ${usage} Sign in as the shared account, not as yourself.`;
  }
  const by = account.connectedBy ?? "the CLI";
  return `Connected by ${by} ${formatRelativeTime(account.connectedAt)}. ${usage}`;
}

/**
 * Connect and disconnect the shared provider accounts that Junior uses for
 * people who have not connected their own account.
 */
export function ServiceAccountsSection(props: {
  accountsQuery: UseQueryResult<z.infer<typeof serviceAccountListSchema>>;
}) {
  const { accountsQuery } = props;
  const queryClient = useQueryClient();
  const connectMutation = useMutation({
    mutationFn: (input: { provider: string; popup: Window | null }) =>
      post(
        startServiceAccountSignInResponseSchema,
        serviceAccountPath(input.provider),
        {},
      ),
    onSuccess: ({ authorizationUrl }, { popup }) => {
      // A blocked popup returns null, so use this tab. A tab the admin
      // closed means they cancelled; keep them on the dashboard.
      if (!popup) {
        window.location.assign(authorizationUrl);
        return;
      }
      if (popup.closed) return;
      popup.opener = null;
      popup.location.href = authorizationUrl;
    },
    onError: (_error, { popup }) => {
      popup?.close();
    },
  });
  const disconnectMutation = useMutation({
    mutationFn: (account: ServiceAccount) =>
      del(
        disconnectServiceAccountResponseSchema,
        serviceAccountPath(account.provider),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: serviceAccountsQueryKey }),
  });

  const accounts = accountsQuery.data?.serviceAccounts ?? [];
  if (accountsQuery.isSuccess && accounts.length === 0) {
    return null;
  }
  const busy = connectMutation.isPending || disconnectMutation.isPending;
  const pendingProvider = connectMutation.isPending
    ? connectMutation.variables?.provider
    : disconnectMutation.isPending
      ? disconnectMutation.variables?.provider
      : undefined;
  const listFailed = !accountsQuery.data && accountsQuery.isError;
  const displayedError = connectMutation.isError
    ? "Could not start the sign-in. Try again."
    : disconnectMutation.isError
      ? "Could not disconnect the account. Try again."
      : listFailed
        ? "Could not load service accounts. Try again."
        : undefined;

  return (
    <Card as="section" padding="md">
      <h2 className="m-0 font-display text-base font-medium text-dashboard-text">
        Service accounts
      </h2>
      <p className="mt-1 mb-4 text-sm text-dashboard-text-muted">
        A shared account that Junior uses for a plugin. It can do only what its
        plugin allows, usually read. Everyone who can talk to{" "}
        {getDashboardAgentName()} can use it, so give it only access that all of
        them may have.
      </p>
      {displayedError ? (
        <InlineError className={listFailed ? undefined : "mb-4"}>
          {displayedError}
        </InlineError>
      ) : null}
      {listFailed ? null : accountsQuery.isPending ? (
        <p className="m-0 text-sm text-dashboard-text-muted">
          Loading service accounts…
        </p>
      ) : (
        <div className="space-y-2">
          {accounts.map((account) => (
            <div
              className="flex items-center gap-3 rounded-md border border-dashboard-border-strong p-3"
              key={account.provider}
            >
              <KeyRound
                aria-hidden="true"
                className="shrink-0 text-dashboard-accent"
                size={16}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="m-0 truncate text-sm font-semibold">
                    {account.displayName}
                  </p>
                  <StatusChip
                    size="compact"
                    tone={
                      account.connected
                        ? "success"
                        : !account.userOAuth
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {account.connected ? "connected" : "not connected"}
                  </StatusChip>
                  {!account.userOAuth ? (
                    <StatusChip size="compact" tone="neutral">
                      shared only
                    </StatusChip>
                  ) : null}
                </div>
                <p className="mt-1 mb-0 break-words text-xs text-dashboard-text-muted">
                  {statusText(account)}
                </p>
                <p className="mt-1 mb-0 break-words font-mono text-xs text-dashboard-text-faint">
                  {account.tools.join(", ")}
                </p>
              </div>
              {account.connected ? (
                <Button
                  aria-busy={
                    disconnectMutation.isPending &&
                    pendingProvider === account.provider
                  }
                  aria-label={`Disconnect the ${account.displayName} service account`}
                  disabled={busy}
                  onClick={() => {
                    connectMutation.reset();
                    disconnectMutation.mutate(account);
                  }}
                  variant="danger"
                >
                  Disconnect
                </Button>
              ) : null}
              <Button
                aria-busy={
                  connectMutation.isPending &&
                  pendingProvider === account.provider
                }
                aria-label={`${account.connected ? "Reconnect" : "Connect"} the ${account.displayName} service account`}
                disabled={busy}
                onClick={() => {
                  disconnectMutation.reset();
                  // Open the tab during the click so popup blockers allow
                  // it, then point it at the provider.
                  const popup = window.open("about:blank", "_blank");
                  connectMutation.mutate({
                    provider: account.provider,
                    popup,
                  });
                }}
              >
                {connectMutation.isPending &&
                pendingProvider === account.provider
                  ? "Connecting…"
                  : account.connected
                    ? "Reconnect"
                    : "Connect"}
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
