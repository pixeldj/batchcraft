import { useEffect, useRef, useState, type ChangeEvent } from "react";

import type { BatchcraftApi } from "../../api/client";
import type { AssetResponse } from "../../api/types";
import { errorMessage } from "../../utils/errors";

interface Props {
  api: BatchcraftApi;
  projectKey: string;
  selectedAssetIds: string[];
  onSelectedAssetIdsChange(assetIds: string[]): void;
}

interface LibraryState {
  projectKey: string;
  assets: AssetResponse[];
  error: string | null;
}

export function ReferenceAssetPicker({
  api,
  projectKey,
  selectedAssetIds,
  onSelectedAssetIdsChange,
}: Props) {
  const normalizedProjectKey = projectKey.trim();
  const [library, setLibrary] = useState<LibraryState>({
    projectKey: "",
    assets: [],
    error: null,
  });
  const [refreshToken, setRefreshToken] = useState(0);
  const [expanded, setExpanded] = useState(() => selectedAssetIds.length === 0);
  const [uploadingProjectKey, setUploadingProjectKey] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<{
    projectKey: string;
    message: string;
  } | null>(null);
  const activeProjectKey = useRef(normalizedProjectKey);
  const loadTag = useRef(0);
  const previousProjectKey = useRef(normalizedProjectKey);
  const currentSelection = useRef(selectedAssetIds);

  useEffect(() => {
    activeProjectKey.current = normalizedProjectKey;
    currentSelection.current = selectedAssetIds;
  }, [normalizedProjectKey, selectedAssetIds]);

  useEffect(() => {
    if (previousProjectKey.current !== normalizedProjectKey) {
      const changedBetweenProjects = Boolean(previousProjectKey.current && normalizedProjectKey);
      previousProjectKey.current = normalizedProjectKey;
      if (changedBetweenProjects) {
        setExpanded(selectedAssetIds.length === 0);
      }
    }
  }, [normalizedProjectKey, selectedAssetIds.length]);

  useEffect(() => {
    const tag = ++loadTag.current;
    if (!normalizedProjectKey) {
      return;
    }
    const controller = new AbortController();
    api
      .listProjectAssets(normalizedProjectKey, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted && tag === loadTag.current) {
          setLibrary({
            projectKey: normalizedProjectKey,
            assets: mergeAssets([], response.assets),
            error: null,
          });
        }
      })
      .catch((caught: unknown) => {
        if (
          tag === loadTag.current &&
          !(caught instanceof DOMException && caught.name === "AbortError")
        ) {
          setLibrary({ projectKey: normalizedProjectKey, assets: [], error: errorMessage(caught) });
        }
      });
    return () => controller.abort();
  }, [api, normalizedProjectKey, refreshToken]);

  const currentLibrary = library.projectKey === normalizedProjectKey ? library : null;
  const assets = currentLibrary?.assets ?? [];
  const selectedAssets = selectedAssetIds.map((assetId) => ({
    assetId,
    asset: assets.find((candidate) => candidate.asset_id === assetId),
  }));
  const unavailableSelectedAssets = currentLibrary
    ? selectedAssets.filter(({ asset }) => asset === undefined)
    : [];
  const loading = Boolean(normalizedProjectKey && currentLibrary === null);
  const uploading = uploadingProjectKey === normalizedProjectKey;

  function toggleAsset(assetId: string) {
    const existingIndex = selectedAssetIds.indexOf(assetId);
    onSelectedAssetIdsChange(
      existingIndex === -1
        ? [...selectedAssetIds, assetId]
        : selectedAssetIds.filter((selectedId) => selectedId !== assetId),
    );
  }

  function selectAll() {
    onSelectedAssetIdsChange([
      ...selectedAssetIds,
      ...assets
        .map((asset) => asset.asset_id)
        .filter((assetId) => !selectedAssetIds.includes(assetId)),
    ]);
  }

  async function uploadFiles(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (!normalizedProjectKey || files.length === 0) {
      return;
    }
    setExpanded(true);
    const requestedProjectKey = normalizedProjectKey;
    setUploadingProjectKey(requestedProjectKey);
    setUploadError(null);
    try {
      const response = await api.uploadProjectAssets(requestedProjectKey, files);
      if (activeProjectKey.current !== requestedProjectKey) {
        return;
      }
      const imported = mergeAssets([], response.assets);
      setLibrary((current) => ({
        projectKey: requestedProjectKey,
        assets: mergeAssets(
          current.projectKey === requestedProjectKey ? current.assets : [],
          imported,
        ),
        error: null,
      }));
      const selected = currentSelection.current;
      onSelectedAssetIdsChange([
        ...selected,
        ...imported.map((asset) => asset.asset_id).filter((assetId) => !selected.includes(assetId)),
      ]);
    } catch (caught) {
      if (activeProjectKey.current === requestedProjectKey) {
        setUploadError({ projectKey: requestedProjectKey, message: errorMessage(caught) });
      }
    } finally {
      if (activeProjectKey.current === requestedProjectKey) {
        setUploadingProjectKey(null);
      }
    }
  }

  return (
    <div className="asset-picker">
      <div className="asset-picker-summary">
        <strong>{selectedAssetIds.length} {selectedAssetIds.length === 1 ? "image" : "images"} selected</strong>
        <button
          className="button-secondary compact"
          type="button"
          aria-expanded={expanded}
          aria-controls="reference-image-picker-content"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Hide images" : "Change selection"}
        </button>
      </div>

      {expanded ? (
        <div className="asset-picker-content" id="reference-image-picker-content">
          <div className="asset-picker-toolbar">
            <p>
              Select in execution order. Deselecting and selecting again moves an image to the end.
            </p>
            <div className="asset-picker-actions">
              <button
                className="button-secondary compact"
                type="button"
                disabled={!normalizedProjectKey || loading}
                onClick={() => setRefreshToken((token) => token + 1)}
              >
                Refresh library
              </button>
              <label className={`button-secondary compact ${uploading ? "disabled" : ""}`}>
                {uploading ? "Importing..." : "Import images"}
                <input
                  className="visually-hidden"
                  type="file"
                  accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
                  multiple
                  disabled={!normalizedProjectKey || uploading}
                  onChange={uploadFiles}
                />
              </label>
            </div>
          </div>

          <div className="asset-selection-actions">
            <div>
              <button
                className="button-link"
                type="button"
                disabled={loading || assets.every((asset) => selectedAssetIds.includes(asset.asset_id))}
                onClick={selectAll}
              >
                Select All
              </button>
              <button
                className="button-link"
                type="button"
                disabled={selectedAssetIds.length === 0}
                onClick={() => onSelectedAssetIdsChange([])}
              >
                Select None
              </button>
            </div>
            <span>{assets.length} Project {assets.length === 1 ? "image" : "images"}</span>
          </div>

          {selectedAssets.length > 0 ? (
            <ol className="selected-assets" aria-label="Selected Reference Assets">
              {selectedAssets.map(({ assetId, asset }) => (
                <li className={asset ? undefined : "missing-asset"} key={assetId}>
                  <span>
                    {asset?.original_filename ?? `${assetId} (missing from Project)`}
                  </span>
                  <button type="button" className="button-link danger" onClick={() => toggleAsset(assetId)}>
                    Remove
                  </button>
                </li>
              ))}
            </ol>
          ) : null}

          {unavailableSelectedAssets.length > 0 ? (
            <p className="operation-error" role="alert">
              Remove missing Reference Assets before Previewing this Batch.
            </p>
          ) : null}

          {!normalizedProjectKey ? (
            <p className="empty-note">Select a Project to load its image library.</p>
          ) : loading ? (
            <p className="empty-note" aria-live="polite">Loading Project images...</p>
          ) : currentLibrary?.error ? (
            <p className="operation-error" role="alert">Asset library: {currentLibrary.error}</p>
          ) : assets.length === 0 ? (
            <p className="empty-note">This Project has no imported images.</p>
          ) : (
            <div className="asset-grid">
              {assets.map((asset) => {
                const selectionIndex = selectedAssetIds.indexOf(asset.asset_id);
                const selected = selectionIndex !== -1;
                return (
                  <button
                    className={`asset-card ${selected ? "selected" : ""}`}
                    type="button"
                    key={asset.asset_id}
                    aria-pressed={selected}
                    aria-label={`${selected ? "Deselect" : "Select"} ${asset.original_filename}`}
                    onClick={() => toggleAsset(asset.asset_id)}
                  >
                    <span className="asset-preview-frame">
                      <img src={api.assetUrl(asset.content_url)} alt="" />
                    </span>
                    <span className="asset-card-name">{asset.original_filename}</span>
                    <span className="asset-card-meta">{formatBytes(asset.byte_size)}</span>
                    {selected ? <span className="selection-order">{selectionIndex + 1}</span> : null}
                  </button>
                );
              })}
            </div>
          )}
          {uploadError?.projectKey === normalizedProjectKey ? (
            <p className="operation-error" role="alert">Import: {uploadError.message}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function mergeAssets(current: AssetResponse[], incoming: AssetResponse[]): AssetResponse[] {
  const byId = new Map(current.map((asset) => [asset.asset_id, asset]));
  for (const asset of incoming) {
    byId.set(asset.asset_id, asset);
  }
  return [...byId.values()].sort(
    (left, right) => right.created_at.localeCompare(left.created_at) || left.sha256.localeCompare(right.sha256),
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}
