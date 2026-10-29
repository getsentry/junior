import { useState } from "react";
import { DirectorySortSelect } from "../../components/controls/DirectorySortSelect";
import { Field, FieldError, FieldLabel } from "../../components/ui/field";
import { FilterGroup } from "../../components/FilterBar";
import { Select } from "../../components/Select";

/** Show shared select arrows at form, filter, and directory sizes. */
export function SelectFixtures() {
  const [sort, setSort] = useState("recent");

  return (
    <div className="grid min-w-0 gap-4">
      <Field>
        <FieldLabel htmlFor="gallery-select-form">Schedule</FieldLabel>
        <Select id="gallery-select-form" defaultValue="weekly">
          <option value="daily">Every day</option>
          <option value="weekly">Every week</option>
        </Select>
      </Field>
      <FilterGroup label="State">
        <Select aria-label="State" variant="filter">
          <option>All states</option>
          <option>Active</option>
          <option>Paused</option>
        </Select>
      </FilterGroup>
      <DirectorySortSelect
        ariaLabel="Gallery sort"
        onChange={setSort}
        options={[
          { label: "Recently created", value: "recent" },
          { label: "Oldest created", value: "oldest" },
        ]}
        value={sort}
      />
      <FilterGroup className="w-36" label="Opened">
        <Select aria-label="Opened">
          <option>Last 90 days</option>
          <option>Any time</option>
        </Select>
      </FilterGroup>
      <Field>
        <FieldLabel htmlFor="gallery-select-disabled">Disabled</FieldLabel>
        <Select id="gallery-select-disabled" disabled>
          <option>Every week</option>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="gallery-select-invalid">Destination</FieldLabel>
        <Select
          id="gallery-select-invalid"
          aria-invalid
          aria-describedby="gallery-select-invalid-error"
        >
          <option value="">Choose a destination</option>
          <option value="conversation">This Conversation</option>
        </Select>
        <FieldError id="gallery-select-invalid-error">
          Choose a destination.
        </FieldError>
      </Field>
    </div>
  );
}
