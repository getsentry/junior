import { KeyRound, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  createdPersonalTokenSchema,
  personalTokenListSchema,
  type PersonalTokenMetadata,
} from "@sentry/junior/api/schema";
import { deleteDashboardResource, fetchDashboardJson, post } from "../http";
import { dashboardContainerClass } from "../styles";
import { getDashboardAgentName } from "../agentName";
import { Button } from "../components/Button";

/** Create and revoke personal API tokens for local clients. */
export function PersonalTokensPage() {
  const [tokens, setTokens] = useState<PersonalTokenMetadata[]>([]);
  const [name, setName] = useState("Local agent");
  const [createdToken, setCreatedToken] = useState<{
    id: string;
    token: string;
  }>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetchDashboardJson(personalTokenListSchema, "/api/personal-tokens")
      .then((result) => setTokens(result.tokens))
      .catch(() => setError("Could not load API tokens. Try again."))
      .finally(() => setLoading(false));
  }, []);

  async function createToken() {
    setBusy(true);
    setError(undefined);
    try {
      const token = await post(
        createdPersonalTokenSchema,
        "/api/personal-tokens",
        { name },
      );
      setTokens((current) => [token, ...current]);
      setCreatedToken({ id: token.id, token: token.token });
    } catch {
      setError("Could not create the API token. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeToken(token: PersonalTokenMetadata) {
    setBusy(true);
    setError(undefined);
    try {
      await deleteDashboardResource(
        `/api/personal-tokens/${encodeURIComponent(token.id)}`,
      );
      setTokens((current) => current.filter((item) => item.id !== token.id));
      setCreatedToken((current) =>
        current?.id === token.id ? undefined : current,
      );
    } catch {
      setError("Could not revoke the API token. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`${dashboardContainerClass} px-4 py-8 md:px-8`}>
      <section className="mx-auto w-full max-w-3xl">
        <h1 className="m-0 text-2xl font-bold">Personal API Tokens</h1>
        <p className="mt-2 mb-0 max-w-2xl text-sm text-[#aaa]">
          Use a token to read {getDashboardAgentName()} APIs from a local agent
          or script. Tokens expire after 90 days.
        </p>

        <div className="mt-6 rounded-lg border border-white/15 bg-[#0b0b0b] p-5">
          {createdToken ? (
            <div className="mt-5 rounded border border-emerald-400/40 bg-emerald-400/5 p-3">
              <p className="mt-0 mb-2 text-sm font-semibold">
                Copy this token now. It won't be shown again.
              </p>
              <code className="block overflow-x-auto rounded bg-black p-2 text-xs text-emerald-300">
                {createdToken.token}
              </code>
              <Button
                className="mt-3"
                onClick={() => {
                  setCreatedToken(undefined);
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
                className="min-w-0 flex-1 rounded border border-white/15 bg-black px-3 py-2 text-sm text-white"
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
              <Button
                disabled={loading || busy || !name.trim()}
                onClick={() => void createToken()}
              >
                Create token
              </Button>
            </div>
          )}

          {error ? <p className="mb-0 text-sm text-rose-300">{error}</p> : null}

          <div className="mt-5 space-y-2">
            {loading ? (
              <p className="text-sm text-[#888]">Loading API tokens…</p>
            ) : tokens.length === 0 ? (
              <p className="text-sm text-[#888]">No active API tokens.</p>
            ) : (
              tokens.map((token) => (
                <div
                  className="flex items-center gap-3 rounded border border-white/10 p-3"
                  key={token.id}
                >
                  <KeyRound className="text-[#beaaff]" size={16} />
                  <div className="min-w-0 flex-1">
                    <p className="m-0 truncate text-sm font-semibold">
                      {token.name}
                    </p>
                    <p className="mt-1 mb-0 text-xs text-[#888]">
                      Ends in {token.tokenSuffix} · Expires{" "}
                      {new Date(token.expiresAt).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    aria-label={`Revoke ${token.name}`}
                    className="cursor-pointer border-0 bg-transparent p-1 text-[#888] hover:text-rose-300"
                    disabled={busy}
                    onClick={() => void revokeToken(token)}
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
