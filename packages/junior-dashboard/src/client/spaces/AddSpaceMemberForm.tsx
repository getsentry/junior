import { useId, useState } from "react";

import { Button } from "../components/ui/button";
import { FieldError } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { DashboardApiError } from "../http";
import { useAddSpaceMember } from "./queries";

/**
 * Add a person to the Space by email. A private Space is hidden from people
 * who are not members, so this is how they get in.
 */
export function AddSpaceMemberForm(props: {
  onAdded(): void;
  spaceId: string;
}) {
  const errorId = useId();
  const add = useAddSpaceMember(props.spaceId);
  const [email, setEmail] = useState("");
  const error = add.error
    ? (add.error instanceof DashboardApiError && add.error.apiError) ||
      "Could not add the person. Try again."
    : undefined;
  return (
    <form
      className="grid gap-1 pb-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!email.trim() || add.isPending) return;
        add.mutate(email.trim(), { onSuccess: props.onAdded });
      }}
    >
      <div className="flex gap-2">
        <Input
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          aria-label="Email"
          autoFocus
          className="h-8 text-xs"
          disabled={add.isPending}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="name@example.com"
          type="email"
          value={email}
        />
        <Button
          disabled={!email.trim() || add.isPending}
          type="submit"
          variant="default"
        >
          Add member
        </Button>
      </div>
      <FieldError id={errorId}>{error}</FieldError>
    </form>
  );
}
