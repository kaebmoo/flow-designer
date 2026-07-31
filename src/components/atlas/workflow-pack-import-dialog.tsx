import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";

import { StatusPill } from "@/components/atlas/page";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useImportPack } from "@/lib/atlas-mutations";
import { toClientAtlasError, describeAtlasError } from "@/lib/atlas-mappers";
import type { AtlasPackImportResponse } from "@/lib/atlas-types";
import {
  MAX_PACK_BYTES,
  parsePackPreview,
  type AtlasPackBundle,
  type PackPreview,
} from "@/lib/workflow-pack";

function ActionError({ error }: { error: unknown }) {
  const atlasError = toClientAtlasError(error);
  const description = describeAtlasError(atlasError).description;
  return (
    <p
      role="alert"
      className={`text-xs leading-relaxed ${
        atlasError.kind === "forbidden" ? "text-accent" : "text-destructive"
      }`}
    >
      {atlasError.kind === "forbidden" ? "Role fact: " : ""}
      {description}
    </p>
  );
}

function previewDetails(preview: PackPreview) {
  return (
    <div className="space-y-4 rounded-md border border-border bg-secondary/20 p-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
        <dt className="font-mono uppercase tracking-widest text-muted-foreground">Pack</dt>
        <dd className="min-w-0 truncate font-semibold">{preview.name}</dd>
        <dt className="font-mono uppercase tracking-widest text-muted-foreground">Version</dt>
        <dd>{preview.version}</dd>
        <dt className="font-mono uppercase tracking-widest text-muted-foreground">Workflows</dt>
        <dd>{preview.workflowNames.length}</dd>
        <dt className="font-mono uppercase tracking-widest text-muted-foreground">Triggers</dt>
        <dd>{preview.triggerCount}</dd>
        <dt className="font-mono uppercase tracking-widest text-muted-foreground">Signature</dt>
        <dd>
          <StatusPill tone={preview.signed ? "success" : "muted"}>
            {preview.signed ? "Signed" : "Unsigned"}
          </StatusPill>
        </dd>
      </dl>
      <div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Workflow names
        </p>
        {preview.workflowNames.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">No workflows listed.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-xs text-foreground">
            {preview.workflowNames.map((name, index) => (
              <li key={`${name}-${index}`} className="truncate">
                {index + 1}. {name}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function WorkflowPackImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const importPack = useImportPack();
  const fileInput = useRef<HTMLInputElement>(null);
  const reader = useRef<FileReader | null>(null);
  const readSequence = useRef(0);
  const [fileName, setFileName] = useState<string | null>(null);
  const [bundle, setBundle] = useState<AtlasPackBundle | null>(null);
  const [preview, setPreview] = useState<PackPreview | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [success, setSuccess] = useState<AtlasPackImportResponse | null>(null);

  const reset = () => {
    readSequence.current += 1;
    if (reader.current?.readyState === FileReader.LOADING) reader.current.abort();
    reader.current = null;
    setFileName(null);
    setBundle(null);
    setPreview(null);
    setReadError(null);
    setReading(false);
    setSuccess(null);
    importPack.reset();
    if (fileInput.current) fileInput.current.value = "";
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && importPack.isPending) return;
    if (!next) reset();
    onOpenChange(next);
  };

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    const sequence = ++readSequence.current;
    setFileName(file.name);
    setBundle(null);
    setPreview(null);
    setSuccess(null);
    importPack.reset();
    setReadError(null);

    if (file.size > MAX_PACK_BYTES) {
      setReading(false);
      setReadError("This pack is larger than the 5 MiB client upload limit.");
      return;
    }

    const nextReader = new FileReader();
    reader.current = nextReader;
    setReading(true);
    nextReader.onload = () => {
      if (sequence !== readSequence.current) return;
      try {
        const parsed: unknown = JSON.parse(String(nextReader.result));
        const mapped = parsePackPreview(parsed, file.size);
        if (!mapped.ok) {
          setReadError(mapped.message);
          return;
        }
        setBundle(parsed as AtlasPackBundle);
        setPreview(mapped.preview);
      } catch {
        setReadError("This file is not valid JSON.");
      } finally {
        setReading(false);
      }
    };
    nextReader.onerror = () => {
      if (sequence !== readSequence.current) return;
      setReading(false);
      setReadError("The pack file could not be read.");
    };
    nextReader.readAsText(file);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Import pack</DialogTitle>
          <DialogDescription>
            Import creates new workflows. It never overwrites or merges existing definitions.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-dashed border-border bg-secondary/10 p-4">
            <input
              ref={fileInput}
              id="workflow-pack-file"
              type="file"
              accept="application/json,.json"
              className="sr-only"
              aria-label="Workflow pack JSON file"
              disabled={reading || importPack.isPending}
              onChange={(event) => handleFile(event.target.files?.[0])}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Choose a JSON pack</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {fileName ?? "Nothing selected"}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={reading || importPack.isPending}
                onClick={() => fileInput.current?.click()}
              >
                {reading ? "Reading…" : "Choose file"}
              </Button>
            </div>
          </div>

          {readError ? <ActionError error={{ kind: "validation", message: readError }} /> : null}

          {preview ? (
            <>
              {preview.schemaVersionSupported ? null : (
                <p
                  role="status"
                  className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-foreground"
                >
                  Atlas will reject this pack because its schema version is
                  {preview.schemaVersion === undefined ? " missing" : ` ${preview.schemaVersion}`};
                  the supported version is 1. You can still submit it to see Atlas&apos;s exact
                  response.
                </p>
              )}
              {previewDetails(preview)}
              <p className="text-xs leading-relaxed text-muted-foreground">
                The bundle carries the graph, policy, interface, and triggers as parsed. Atlas
                imports the whole pack atomically or creates nothing.
              </p>
            </>
          ) : bundle === null && !readError && !reading ? (
            <p className="text-xs text-muted-foreground">
              Select a pack to preview it before any request is sent to Atlas.
            </p>
          ) : null}

          {importPack.error ? <ActionError error={importPack.error} /> : null}

          {success ? (
            <div className="space-y-2 rounded-md border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 p-4">
              <p className="text-sm font-semibold">Pack imported</p>
              <p className="text-xs text-muted-foreground">
                Atlas created {success.workflows.length} new workflow
                {success.workflows.length === 1 ? "" : "s"}.
              </p>
              <ul className="space-y-1 text-xs">
                {success.workflows.map((workflow) => (
                  <li key={workflow.id}>
                    <Link
                      to="/workflows/$id"
                      params={{ id: workflow.id }}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {workflow.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:space-x-0">
          <Button
            type="button"
            variant="outline"
            disabled={importPack.isPending}
            onClick={() => handleOpenChange(false)}
          >
            Close
          </Button>
          <Button
            type="button"
            disabled={bundle === null || reading || importPack.isPending || success !== null}
            onClick={() => {
              if (bundle === null) return;
              importPack.mutate(bundle, {
                onSuccess: (created) => setSuccess(created),
              });
            }}
          >
            {importPack.isPending ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
