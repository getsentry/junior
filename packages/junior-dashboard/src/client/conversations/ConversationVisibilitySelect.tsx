import { Globe2, LockKeyhole } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

// The select hides the other choice, so each option says what it means.
// See policies/conversation-access.md.
const options = [
  {
    description: "Other conversations can read it",
    icon: Globe2,
    label: "Public",
    value: "public",
  },
  {
    description: "Other conversations can't see it",
    icon: LockKeyhole,
    label: "Private",
    value: "private",
  },
] as const;

type Visibility = (typeof options)[number]["value"];

/** Choose whether other conversations can read a new conversation. */
export function ConversationVisibilitySelect(props: {
  onChange(value: Visibility): void;
  value: Visibility;
}) {
  return (
    <Select<Visibility>
      onValueChange={(next) => {
        if (next) props.onChange(next);
      }}
      value={props.value}
    >
      <SelectTrigger aria-label="Conversation visibility">
        <SelectValue>
          {(value: Visibility) => {
            const option = options.find((item) => item.value === value);
            if (!option) return null;
            return (
              <>
                <option.icon aria-hidden="true" className="size-3" />
                {option.label}
              </>
            );
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="min-w-64">
        {options.map((option) => (
          <SelectItem
            description={option.description}
            key={option.value}
            value={option.value}
          >
            <option.icon aria-hidden="true" />
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
