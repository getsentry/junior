import { useState } from "react";
import { Checkbox } from "../../components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";

/** Show shared checkbox and radio controls in checked, idle, and disabled states. */
export function ChoiceFixtures() {
  const [events, setEvents] = useState(["opened"]);
  const [mode, setMode] = useState("creator");

  return (
    <div className="grid min-w-0 gap-5 text-sm">
      <div className="grid gap-3">
        {["opened", "closed"].map((event) => (
          <label className="flex cursor-pointer items-center gap-3" key={event}>
            <Checkbox
              checked={events.includes(event)}
              onCheckedChange={(checked) =>
                setEvents((current) =>
                  checked
                    ? [...current, event]
                    : current.filter((value) => value !== event),
                )
              }
            />
            Issue {event}
          </label>
        ))}
        <label className="flex cursor-not-allowed items-center gap-3">
          <Checkbox checked disabled />
          Disabled
        </label>
      </div>
      <RadioGroup
        aria-label="Gallery credential mode"
        className="grid gap-3"
        onValueChange={setMode}
        value={mode}
      >
        <label className="flex cursor-pointer items-center gap-3">
          <RadioGroupItem value="creator" />
          Creator credentials
        </label>
        <label className="flex cursor-pointer items-center gap-3">
          <RadioGroupItem value="system" />
          System credentials
        </label>
        <label className="flex cursor-not-allowed items-center gap-3">
          <RadioGroupItem disabled value="none" />
          Disabled
        </label>
      </RadioGroup>
    </div>
  );
}
