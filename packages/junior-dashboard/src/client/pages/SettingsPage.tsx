import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { contextDistillationPreferenceSchema } from "@sentry/junior/api/schema";

import {
  dashboardIdentitySchema,
  type DashboardIdentity,
} from "../../api/schema";
import { Button } from "../components/Button";
import { Field } from "../components/Field";
import { InlineError } from "../components/InlineError";
import { Card } from "../components/layout/Card";
import { TextInput } from "../components/TextInput";
import { fetchDashboardJson, patch } from "../http";
import { dashboardContainerClass } from "../styles";
import type { DashboardCoreData } from "../types";

const dashboardCoreQueryKey = ["dashboard", "core"] as const;
const distillationQueryKey = ["me", "distillation"] as const;
const distillationPath = "/api/me/distillation";

type SettingsPageProps = {
  identity: DashboardIdentity;
};

/** Let the signed-in user manage their dashboard profile. */
export function SettingsPage({ identity }: SettingsPageProps) {
  const queryClient = useQueryClient();
  const distillation = useQuery({
    queryKey: distillationQueryKey,
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        contextDistillationPreferenceSchema,
        distillationPath,
        signal,
      ),
  });
  const updateDistillation = useMutation({
    mutationFn: (enabled: boolean) =>
      patch(contextDistillationPreferenceSchema, distillationPath, { enabled }),
    onSuccess: (saved) => {
      queryClient.setQueryData(distillationQueryKey, saved);
    },
  });
  const [displayName, setDisplayName] = useState(identity.user.name ?? "");
  useEffect(() => {
    setDisplayName(identity.user.name ?? "");
  }, [identity.user.name]);
  const updateProfile = useMutation({
    mutationFn: (name: string) =>
      patch(dashboardIdentitySchema, "/api/me", { displayName: name }),
    onSuccess: (updated) => {
      queryClient.setQueryData<DashboardCoreData>(
        dashboardCoreQueryKey,
        (current) => (current ? { ...current, me: updated } : current),
      );
      setDisplayName(updated.user.name ?? "");
    },
  });
  const savedName = identity.user.name?.trim() ?? "";
  const trimmedName = displayName.trim();
  const canSave =
    trimmedName.length > 0 &&
    trimmedName.length <= 80 &&
    trimmedName !== savedName &&
    !updateProfile.isPending;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canSave) updateProfile.mutate(trimmedName);
  }

  return (
    <div className={`${dashboardContainerClass} px-4 py-8 md:px-8`}>
      <section className="mx-auto w-full max-w-3xl">
        <h1 className="m-0 text-2xl font-bold">Settings</h1>
        <p className="mt-2 mb-0 max-w-2xl text-sm text-dashboard-text-muted">
          Manage your account and Conversation settings.
        </p>

        <form className="mt-6" onSubmit={submit}>
          <Card className="mb-0" padding="md" variant="raised">
            <h2 className="m-0 text-lg font-bold">Profile</h2>
            <Field
              className="mt-5"
              help="Your display name is shown with your conversations and activity."
              htmlFor="display-name"
              label="Display name"
            >
              <TextInput
                autoComplete="name"
                id="display-name"
                maxLength={80}
                onChange={(event) => {
                  setDisplayName(event.target.value);
                  if (updateProfile.isError || updateProfile.isSuccess) {
                    updateProfile.reset();
                  }
                }}
                value={displayName}
              />
            </Field>
            <div className="mt-5 flex items-center gap-3">
              <Button disabled={!canSave} type="submit">
                {updateProfile.isPending ? "Saving…" : "Save changes"}
              </Button>
              {updateProfile.isSuccess ? (
                <p className="m-0 text-sm text-emerald-300">Changes saved.</p>
              ) : null}
              {updateProfile.isError ? (
                <InlineError>
                  Could not save your display name. Try again.
                </InlineError>
              ) : null}
            </div>
          </Card>
        </form>

        <Card className="mt-6" padding="md" variant="raised">
          <h2 className="m-0 text-lg font-bold">Conversation context</h2>
          <p className="mt-2 mb-0 text-sm text-dashboard-text-muted">
            Junior can make short observations from older parts of your private
            Conversations. It uses them only when its cost check predicts a
            saving. Your current instructions and recent work stay in context.
          </p>
          {distillation.isPending ? (
            <p className="mt-4 text-sm text-dashboard-text-muted" role="status">
              Loading your preference…
            </p>
          ) : distillation.isError ? (
            <div className="mt-4">
              <InlineError>
                Could not load your preference. Try again.
              </InlineError>
            </div>
          ) : (
            <>
              <label className="mt-5 flex items-start gap-3 text-sm">
                <input
                  checked={distillation.data.enabled}
                  className="mt-0.5 size-4 shrink-0 accent-dashboard-focus"
                  disabled={updateDistillation.isPending}
                  onChange={(event) =>
                    updateDistillation.mutate(event.target.checked)
                  }
                  type="checkbox"
                />
                <span>Allow distillation for my private Conversations</span>
              </label>
              {!distillation.data.available ? (
                <p className="mt-2 mb-0 text-sm text-dashboard-text-muted">
                  You can save your choice now. Distillation will not run until
                  it is available for your account.
                </p>
              ) : null}
              {updateDistillation.isError ? (
                <div className="mt-3">
                  <InlineError>
                    Could not save your preference. Try again.
                  </InlineError>
                </div>
              ) : null}
            </>
          )}
        </Card>
      </section>
    </div>
  );
}
