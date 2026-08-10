import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useExportPack } from "@/lib/atlas-mutations";
import { describeAtlasError, toClientAtlasError } from "@/lib/atlas-mappers";
import { packFilenameForWorkflow, type AtlasPackBundle } from "@/lib/workflow-pack";

function downloadPack(bundle: AtlasPackBundle, workflowName: string) {
  const blob = new Blob([`${JSON.stringify(bundle, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = packFilenameForWorkflow(workflowName);
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function WorkflowPackExportAction({
  definitionId,
  workflowName,
}: {
  definitionId: string;
  workflowName: string;
}) {
  const exportPack = useExportPack();
  const error = exportPack.error ? toClientAtlasError(exportPack.error) : null;

  // A fragment, not a column: the parent lays these out in its own flex-wrap action row,
  // so the button lines up flush with its siblings instead of dragging a caption along.
  // The pack-contents note reaches keyboard/SR users via aria-describedby and sighted
  // users on hover; an error claims a full row of its own beneath the buttons.
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={exportPack.isPending}
        aria-busy={exportPack.isPending}
        aria-describedby="pack-export-note"
        title="Includes graph, policy, interface, synthetic sample input, and triggers. The default reply is not included in a pack."
        onClick={() =>
          exportPack.mutate(
            { definitionId },
            { onSuccess: (bundle) => downloadPack(bundle, workflowName) },
          )
        }
      >
        <Download className="mr-1.5 size-3.5" aria-hidden="true" />
        {exportPack.isPending ? "Exporting…" : "Export pack"}
      </Button>
      <span id="pack-export-note" className="sr-only">
        Includes graph, policy, interface, synthetic sample input, and triggers. The default reply
        is not included in a pack.
      </span>
      {error ? (
        <p
          role="alert"
          className={`basis-full text-right text-xs leading-relaxed ${
            error.kind === "forbidden" ? "text-accent" : "text-destructive"
          }`}
        >
          {error.kind === "forbidden" ? "Role fact: " : ""}
          {describeAtlasError(error).description}
        </p>
      ) : null}
    </>
  );
}
