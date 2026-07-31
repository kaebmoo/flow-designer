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

  return (
    <div className="flex max-w-sm flex-col items-end gap-1.5">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={exportPack.isPending}
        aria-busy={exportPack.isPending}
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
      <p className="text-right text-[10px] leading-relaxed text-muted-foreground">
        Includes graph, policy, interface, synthetic sample input, and triggers. The default reply
        is not included in a pack.
      </p>
      {error ? (
        <p
          role="alert"
          className={`text-right text-xs leading-relaxed ${
            error.kind === "forbidden" ? "text-accent" : "text-destructive"
          }`}
        >
          {error.kind === "forbidden" ? "Role fact: " : ""}
          {describeAtlasError(error).description}
        </p>
      ) : null}
    </div>
  );
}
