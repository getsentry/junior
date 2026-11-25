import { PeoplePicker } from "../components/PeoplePicker";
import { useAddSpaceMember } from "./queries";

/**
 * Add people to the Space. A private Space is hidden from people who are
 * not members, so this is how they get in.
 */
export function AddSpaceMembers(props: { onDone(): void; spaceId: string }) {
  const add = useAddSpaceMember(props.spaceId);
  return (
    <PeoplePicker
      add={async (user) => {
        await add.mutateAsync(user.email);
      }}
      label="Add members"
      memberLabel="Member"
      onCancel={props.onDone}
      onDone={props.onDone}
      submitLabel="Add"
      target={{ spaceId: props.spaceId }}
    />
  );
}
