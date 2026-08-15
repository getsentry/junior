import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";

import {
  dashboardIdentitySchema,
  type DashboardIdentity,
} from "../../api/schema";
import { Button } from "../components/Button";
import { InlineError } from "../components/InlineError";
import { patch } from "../http";
import { dashboardContainerClass } from "../styles";
import type { DashboardCoreData } from "../types";

const dashboardCoreQueryKey = ["dashboard", "core"] as const;

type SettingsPageProps = {
  identity: DashboardIdentity;
};

/** Let the signed-in user manage their dashboard profile. */
export function SettingsPage({ identity }: SettingsPageProps) {
  const queryClient = useQueryClient();
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
          Manage how your account appears in the dashboard.
        </p>

        <form
          className="mt-6 rounded-lg border border-white/15 bg-dashboard-surface-raised p-5"
          onSubmit={submit}
        >
          <h2 className="m-0 text-lg font-bold">Profile</h2>
          <label
            className="mt-5 block text-sm font-semibold"
            htmlFor="display-name"
          >
            Display name
          </label>
          <input
            autoComplete="name"
            className="mt-2 block w-full rounded border border-white/15 bg-black px-3 py-2 text-sm text-dashboard-text focus:border-[#beaaff] focus:outline-none"
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
          <p className="mt-2 mb-0 text-xs text-dashboard-text-muted">
            Your display name is shown with your conversations and activity.
          </p>
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
        </form>
      </section>
    </div>
  );
}
