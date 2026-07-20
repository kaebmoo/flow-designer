/**
 * The date-range filter shared by the audit and usage pages.
 *
 * The two values are Atlas's own `from`/`to` query parameters — inclusive ISO dates applied
 * server-side by Atlas, never a client-side row filter. Submitting writes them to the URL, so
 * a range is shareable and survives reload.
 *
 * Draft state is seeded from props once per mount, so callers must `key` this component by
 * the applied range: browser Back/Forward changes the URL without remounting the page, and an
 * un-keyed form would keep showing the previous range above data that has already changed.
 */

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function DateRangeForm({
  from,
  to,
  onApply,
}: {
  from: string | undefined;
  to: string | undefined;
  onApply: (next: { from: string | undefined; to: string | undefined }) => void;
}) {
  const [fromDraft, setFromDraft] = useState(from ?? "");
  const [toDraft, setToDraft] = useState(to ?? "");

  return (
    <form
      className="mb-6 flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onApply({ from: fromDraft || undefined, to: toDraft || undefined });
      }}
    >
      <div>
        <Label htmlFor="range-from" className="text-xs text-muted-foreground">
          From (inclusive)
        </Label>
        <Input
          id="range-from"
          type="date"
          value={fromDraft}
          onChange={(event) => setFromDraft(event.target.value)}
          className="mt-1 w-44"
        />
      </div>
      <div>
        <Label htmlFor="range-to" className="text-xs text-muted-foreground">
          To (inclusive)
        </Label>
        <Input
          id="range-to"
          type="date"
          value={toDraft}
          onChange={(event) => setToDraft(event.target.value)}
          className="mt-1 w-44"
        />
      </div>
      <Button type="submit" variant="outline" size="sm">
        Apply range
      </Button>
      {from || to ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setFromDraft("");
            setToDraft("");
            onApply({ from: undefined, to: undefined });
          }}
        >
          Clear
        </Button>
      ) : null}
    </form>
  );
}
