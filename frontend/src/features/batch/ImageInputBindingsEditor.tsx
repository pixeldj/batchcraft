import { useEffect, useRef, useState, type ChangeEvent } from "react";

import type { BatchcraftApi } from "../../api/client";
import type { AssetResponse, ImageBindingRequest, WorkflowProfileImageInput } from "../../api/types";
import { errorMessage } from "../../utils/errors";
import { profileImageInputs, reconcileImageBindings } from "./form";

interface Props {
  api: BatchcraftApi;
  projectKey: string;
  profileJson: string;
  imageBindings: ImageBindingRequest[];
  onChange(bindings: ImageBindingRequest[]): void;
}

export function ImageInputBindingsEditor({ api, projectKey, profileJson, imageBindings, onChange }: Props) {
  let slots: WorkflowProfileImageInput[];
  try {
    slots = profileImageInputs(profileJson);
  } catch {
    slots = [];
  }
  const bindings = reconcileImageBindings(imageBindings, slots);
  const normalizedProjectKey = projectKey.trim();
  const [assets, setAssets] = useState<AssetResponse[]>([]);
  const [loadedProjectKey, setLoadedProjectKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [uploading, setUploading] = useState(false);
  const loadTag = useRef(0);
  const hasSlots = slots.length > 0;

  useEffect(() => {
    const tag = ++loadTag.current;
    if (!normalizedProjectKey || !hasSlots) {
      return;
    }
    const controller = new AbortController();
    void api.listProjectAssets(normalizedProjectKey, controller.signal).then(
      (response) => {
        if (tag !== loadTag.current || controller.signal.aborted) return;
        setAssets(sortAssets(response.assets));
        setLoadedProjectKey(normalizedProjectKey);
        setError(null);
      },
      (caught: unknown) => {
        if (tag !== loadTag.current || isAbort(caught)) return;
        setAssets([]);
        setLoadedProjectKey(normalizedProjectKey);
        setError(errorMessage(caught));
      },
    );
    return () => controller.abort();
  }, [api, hasSlots, normalizedProjectKey, refreshToken]);

  if (slots.length === 0) return null;

  const loading = Boolean(normalizedProjectKey && loadedProjectKey !== normalizedProjectKey);
  const visibleAssets = loadedProjectKey === normalizedProjectKey ? assets : [];
  const byId = new Map(visibleAssets.map((asset) => [asset.asset_id, asset]));

  function setSlotValues(slotKey: string, values: Array<string | null>) {
    onChange(bindings.map((binding) => binding.slot_key === slotKey
      ? { ...binding, values }
      : binding));
  }

  function toggleBase(slotKey: string, values: Array<string | null>) {
    setSlotValues(
      slotKey,
      values.includes(null) ? values.filter((value) => value !== null) : [null, ...values],
    );
  }

  function toggleAsset(slotKey: string, values: Array<string | null>, assetId: string) {
    if (values.includes(assetId)) {
      setSlotValues(slotKey, values.filter((value) => value !== assetId));
      return;
    }
    setSlotValues(slotKey, [...values, assetId]);
  }

  async function uploadFiles(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (!normalizedProjectKey || files.length === 0) return;
    const tag = loadTag.current;
    const requestedProjectKey = normalizedProjectKey;
    setUploading(true);
    setError(null);
    try {
      const response = await api.uploadProjectAssets(normalizedProjectKey, files);
      if (tag !== loadTag.current) return;
      setAssets((current) => sortAssets([...current, ...response.assets]));
      setLoadedProjectKey(requestedProjectKey);
    } catch (caught) {
      if (tag !== loadTag.current) return;
      setError(errorMessage(caught));
    } finally {
      setUploading(false);
    }
  }

  return (
    <fieldset className="image-input-bindings">
      <legend>Image Inputs</legend>
      <div className="asset-picker-toolbar">
        <p>Choose one or more ordered alternatives per slot. Alternatives expand into concrete Jobs. Remove and select an Asset again to move it to the end.</p>
        <div className="asset-picker-actions">
          <button className="button-secondary compact" type="button" disabled={!normalizedProjectKey || loading} onClick={() => setRefreshToken((value) => value + 1)}>Refresh library</button>
          <label className={`button-secondary compact ${uploading ? "disabled" : ""}`}>
            {uploading ? "Importing..." : "Import images"}
            <input className="visually-hidden" type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" multiple disabled={!normalizedProjectKey || uploading} onChange={uploadFiles} />
          </label>
        </div>
      </div>
      <div className="image-input-binding-list">
        {slots.map((slot) => {
          const binding = bindings.find((candidate) => candidate.slot_key === slot.key);
          const values = binding?.values ?? [];
          const missingIds = values.filter(
            (value): value is string => Boolean(
              value && loadedProjectKey === normalizedProjectKey && !error && !byId.has(value)
            ),
          );
          return (
            <section className={`workflow-mapping-card image-input-slot ${missingIds.length ? "invalid" : ""}`} key={slot.key} aria-labelledby={`image-slot-${slot.key}`}>
              <div className="image-input-slot-heading">
                <h3 id={`image-slot-${slot.key}`}>{slot.label}</h3>
                <span>{values.length} {values.length === 1 ? "alternative" : "alternatives"}</span>
              </div>
              {values.length ? (
                <ol className="selected-assets" aria-label={`${slot.label} selected alternatives`}>
                  {values.map((value, index) => {
                    const asset = value === null ? null : byId.get(value);
                    const displayName = value === null
                      ? "Base workflow"
                      : asset?.original_filename ?? `Missing Project Asset ${index + 1}`;
                    return (
                      <li className={value !== null && !asset ? "missing-asset" : ""} key={value ?? "base-workflow"}>
                        <span>{displayName}</span>
                        <button
                          className="button-link compact"
                          type="button"
                          aria-label={`Remove selected ${displayName} alternative from ${slot.label}`}
                          onClick={() => value === null
                            ? toggleBase(slot.key, values)
                            : toggleAsset(slot.key, values, value)}
                        >
                          Remove
                        </button>
                      </li>
                    );
                  })}
                </ol>
              ) : <p className="operation-error">Choose at least one alternative before Preview.</p>}
              <div className="asset-grid image-input-alternatives">
                <button
                  className={`asset-card base-workflow-card ${values.includes(null) ? "selected" : ""}`}
                  type="button"
                  aria-pressed={values.includes(null)}
                  aria-label={`Base workflow for ${slot.label}`}
                  onClick={() => toggleBase(slot.key, values)}
                >
                  <span className="base-workflow-mark">Base</span>
                  <span className="asset-card-name">Base workflow</span>
                  <span className="asset-card-meta">Leave this workflow input unchanged</span>
                  {values.includes(null) ? <span className="selection-order">1</span> : null}
                </button>
                {visibleAssets.map((candidate) => {
                  const selectedIndex = values.indexOf(candidate.asset_id);
                  const selected = selectedIndex >= 0;
                  return (
                    <button
                      className={`asset-card ${selected ? "selected" : ""}`}
                      type="button"
                      key={candidate.asset_id}
                      aria-pressed={selected}
                      aria-label={`${selected ? "Remove" : "Add"} ${candidate.original_filename} ${selected ? "from" : "to"} ${slot.label}`}
                      disabled={!normalizedProjectKey || loading}
                      onClick={() => toggleAsset(slot.key, values, candidate.asset_id)}
                    >
                      <span className="asset-preview-frame"><img src={api.assetUrl(candidate.content_url)} alt="" /></span>
                      <span className="asset-card-name">{candidate.original_filename}</span>
                      <span className="asset-card-meta">{formatBytes(candidate.byte_size)}</span>
                      {selected ? <span className="selection-order">{selectedIndex + 1}</span> : null}
                    </button>
                  );
                })}
              </div>
              {missingIds.length ? <p className="operation-error">One or more selected Project Assets are missing. Remove or replace them before Preview.</p> : null}
            </section>
          );
        })}
      </div>
      {!normalizedProjectKey ? <p className="empty-note">Select a Project to load its image library.</p> : null}
      {loading ? <p role="status">Loading Project images...</p> : null}
      {error ? <p className="operation-error" role="alert">Asset library: {error}</p> : null}
    </fieldset>
  );
}

function sortAssets(assets: AssetResponse[]): AssetResponse[] {
  return [...new Map(assets.map((asset) => [asset.asset_id, asset])).values()].sort(
    (left, right) => right.created_at.localeCompare(left.created_at) || left.sha256.localeCompare(right.sha256),
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
