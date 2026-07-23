import { useCallback, useState } from "react";

import { toClientAtlasError, type ArtifactView, type ClientAtlasError } from "@/lib/atlas-mappers";
import type { AtlasErrorKind } from "@/lib/atlas-types";

const DOWNLOAD_ERROR_KINDS: Record<number, AtlasErrorKind> = {
  400: "validation",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
  504: "timeout",
};

async function readArtifactDownloadError(response: Response): Promise<ClientAtlasError> {
  const kind = DOWNLOAD_ERROR_KINDS[response.status] ?? "server";
  const body = await response.text().catch(() => "");
  return toClientAtlasError({
    kind,
    message: body.trim() || "The download could not be completed.",
  });
}

export function useArtifactDownloads() {
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<ClientAtlasError | null>(null);

  const downloadArtifact = useCallback(async (artifact: ArtifactView) => {
    setError(null);
    setPendingIds((current) => new Set(current).add(artifact.id));
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(artifact.id)}/content`);
      if (!response.ok) {
        setError(await readArtifactDownloadError(response));
        return;
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = artifact.filename ?? artifact.key;
      link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch {
      setError(
        toClientAtlasError({
          kind: "network",
          message: "The browser could not reach this origin to fetch the artifact.",
        }),
      );
    } finally {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(artifact.id);
        return next;
      });
    }
  }, []);

  return { pendingIds, downloadError: error, downloadArtifact };
}
