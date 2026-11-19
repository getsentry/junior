import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  gatewayOnlyProviders,
  gatewayProvidersSchema,
  type GatewayProviders,
} from "@sentry/junior/api/schema";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Field, FieldLabel } from "../../components/ui/field";
import { InlineError } from "../../components/InlineError";
import { Card } from "../../components/layout/Card";
import { AnchorHeading } from "../../components/layout/AnchorHeading";
import { fetchDashboardJson, put } from "../../http";

const queryKey = ["dashboard", "gateway-providers"] as const;
const PATH = "/api/gateway-providers";

/** Null when every listed provider is checked, which leaves routing as is. */
function enabledFromDraft(
  providers: string[],
  checked: ReadonlySet<string>,
): string[] | null {
  return providers.every((provider) => checked.has(provider))
    ? null
    : providers.filter((provider) => checked.has(provider));
}

/**
 * Let an admin pick the upstream providers that AI Gateway may route agent
 * model calls to, and show which providers each model then uses.
 */
export function GatewayProvidersSection() {
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      fetchDashboardJson(gatewayProvidersSchema, PATH, signal),
    retry: false,
  });
  return (
    <Card as="section" padding="md">
      <AnchorHeading
        anchor="enabled-providers"
        className="m-0 font-display text-base font-medium text-dashboard-text"
        title="Enabled providers"
      />
      <p className="mt-1 mb-4 text-sm text-dashboard-text-muted">
        AI Gateway sends agent model calls only to checked providers that serve
        the model. A model that no checked provider serves can use any provider.
        Unchecked providers are not used as a fallback.
      </p>
      {query.data ? (
        <ProvidersForm data={query.data} key={JSON.stringify(query.data)} />
      ) : query.isError ? (
        <InlineError>Could not load providers. Try again.</InlineError>
      ) : (
        <p className="m-0 text-sm text-dashboard-text-muted">
          Loading providers…
        </p>
      )}
    </Card>
  );
}

function ProvidersForm(props: { data: GatewayProviders }) {
  const { providers, models } = props.data;
  const queryClient = useQueryClient();
  const [checked, setChecked] = useState(
    () => new Set(props.data.enabled ?? providers),
  );
  const save = useMutation({
    mutationFn: (enabled: string[] | null) =>
      put(gatewayProvidersSchema, PATH, { enabled }),
    onSuccess: (data) => queryClient.setQueryData(queryKey, data),
  });
  const draft = enabledFromDraft(providers, checked);
  const saved = enabledFromDraft(
    providers,
    new Set(props.data.enabled ?? providers),
  );
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        {providers.map((provider) => (
          <Field key={provider} orientation="horizontal">
            <Checkbox
              checked={checked.has(provider)}
              disabled={save.isPending}
              id={`gateway-provider-${provider}`}
              onCheckedChange={(next) => {
                const updated = new Set(checked);
                if (next) updated.add(provider);
                else updated.delete(provider);
                setChecked(updated);
              }}
            />
            <FieldLabel
              className="font-mono font-normal"
              htmlFor={`gateway-provider-${provider}`}
            >
              {provider}
            </FieldLabel>
          </Field>
        ))}
      </div>
      <dl className="m-0 grid gap-2 rounded-md border border-dashboard-border-strong p-3 text-sm">
        {models.map((model) => {
          const only = gatewayOnlyProviders(draft, model.providers);
          return (
            <div
              className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
              key={model.id}
            >
              <dt className="min-w-0 truncate font-mono text-dashboard-text">
                {model.id}
              </dt>
              <dd className="m-0 min-w-0 text-dashboard-text-muted">
                {only ? (
                  <span className="font-mono">{only.join(", ")}</span>
                ) : (
                  "Any provider"
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {save.isError ? (
        <InlineError>Could not save providers. Try again.</InlineError>
      ) : null}
      <div className="flex justify-end">
        <Button
          aria-busy={save.isPending}
          disabled={!changed || save.isPending}
          onClick={() => save.mutate(draft)}
          variant="outline"
        >
          Save
        </Button>
      </div>
    </div>
  );
}
