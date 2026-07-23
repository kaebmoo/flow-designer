import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState, type MouseEvent } from "react";

import { useReturnFocus } from "@/hooks/use-return-focus";
import {
  describeAtlasError,
  toClientAtlasError,
  type ArtifactView,
  type ClientAtlasError,
} from "@/lib/atlas-mappers";
import { artifactPreviewQuery } from "@/lib/atlas-queries";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function artifactOriginLabel(artifact: ArtifactView): string {
  if (artifact.runId) return `run ${artifact.runId}`;
  if (artifact.jobId) return `job ${artifact.jobId}`;
  return `artifact ${artifact.id}`;
}

function artifactActionLabel(action: "Download" | "Preview", artifact: ArtifactView): string {
  return `${action} ${artifact.key} (${artifactOriginLabel(artifact)}, id ${artifact.id})`;
}

export function ArtifactContentActions({
  artifact,
  downloading,
  onDownload,
}: {
  artifact: ArtifactView;
  downloading: boolean;
  onDownload: (artifact: ArtifactView) => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const { capture, restore } = useReturnFocus();

  const closePreview = useCallback(() => {
    setPreviewOpen(false);
    restore();
  }, [restore]);

  if (artifact.downloadable) {
    return (
      <Button
        size="sm"
        variant="outline"
        aria-label={artifactActionLabel("Download", artifact)}
        disabled={downloading}
        onClick={() => onDownload(artifact)}
      >
        {downloading ? "Downloading..." : "Download"}
      </Button>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        aria-label={artifactActionLabel("Preview", artifact)}
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          capture(event.currentTarget);
          setPreviewOpen(true);
        }}
      >
        Preview
      </Button>
      {previewOpen ? <ArtifactPreviewDialog artifact={artifact} onClose={closePreview} /> : null}
    </>
  );
}

export function ArtifactDownloadError({ error }: { error: ClientAtlasError | null }) {
  const router = useRouter();

  useEffect(() => {
    if (error?.kind === "unauthorized") {
      void router.navigate({ to: "/auth", replace: true });
    }
  }, [error?.kind, router]);

  if (!error) return null;
  const { title, description } = describeAtlasError(error);

  return (
    <div role="alert" className="mt-3 rounded border border-destructive/30 px-3 py-2 text-sm">
      <p className="font-mono text-[10px] uppercase tracking-widest text-destructive">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-foreground">{description}</p>
    </div>
  );
}

function ArtifactPreviewDialog({
  artifact,
  onClose,
}: {
  artifact: ArtifactView;
  onClose: () => void;
}) {
  const router = useRouter();
  const preview = useQuery(artifactPreviewQuery(artifact.id));
  const error = preview.isError ? toClientAtlasError(preview.error) : null;
  const presentation = error ? describeAtlasError(error) : null;
  const data = preview.data;

  useEffect(() => {
    if (error?.kind === "unauthorized") {
      void router.navigate({ to: "/auth", replace: true });
    }
  }, [error?.kind, router]);

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Preview {artifact.key}</DialogTitle>
          <DialogDescription>
            Loaded on demand from Atlas. Artifact lists keep metadata only.
          </DialogDescription>
        </DialogHeader>

        {preview.isPending ? (
          <p role="status" className="py-8 text-center font-mono text-xs text-muted-foreground">
            Loading preview...
          </p>
        ) : error && presentation ? (
          <div role="alert" className="rounded-md border border-destructive/40 p-4 text-sm">
            <p className="font-mono text-[10px] uppercase tracking-widest text-destructive">
              {presentation.title}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-foreground">
              {presentation.description}
            </p>
            {presentation.retryable ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={() => void preview.refetch()}
              >
                Retry
              </Button>
            ) : null}
          </div>
        ) : data === undefined ? null : data.preview === null ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            This file artifact is available through Download instead of inline preview.
          </p>
        ) : (
          <div className="min-h-0">
            <pre
              data-testid="artifact-preview"
              className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-secondary/20 p-4 font-mono text-xs leading-relaxed"
            >
              {data.preview}
            </pre>
            {data.truncated ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Preview limited to the first 32,000 characters.
              </p>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
