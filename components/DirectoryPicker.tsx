"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalDialog } from "@/hooks/useModalDialog";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { appendProgress, cloneDirectoryName } from "@/lib/git-clone";
import { comparableProjectPath } from "@/lib/comparable-path";
import { getDirectoryBreadcrumbs } from "@/lib/directory-picker-path";

interface DirectoryEntry {
  name: string;
  path: string;
}

interface BrowseResponse {
  path?: string;
  parentPath?: string | null;
  directories?: DirectoryEntry[];
  drives?: DirectoryEntry[];
  error?: string;
  code?: string;
}

interface DirectoryListing {
  path: string;
  parentPath: string | null;
  directories: DirectoryEntry[];
  drives?: DirectoryEntry[];
}

interface DirectoryView {
  level: DirectoryListing;
  selected: DirectoryEntry | null;
  child: DirectoryListing | null;
}

async function loadDirectories(directory?: string, signal?: AbortSignal): Promise<DirectoryListing> {
  const query = directory ? `?path=${encodeURIComponent(directory)}` : "";
  const response = await fetch(`/api/cwd/browse${query}`, { signal });
  const data = await response.json() as BrowseResponse;
  if (!response.ok || data.error) {
    throw new Error(formatApiError({ ...data, error: data.error ?? `HTTP ${response.status}` }));
  }
  return { path: data.path ?? directory ?? "", parentPath: data.parentPath ?? null, directories: data.directories ?? [], drives: data.drives };
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M1.5 3h4l1.5 2h7.5v7.5h-13z" />
    </svg>
  );
}

function DriveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 9h12" />
      <circle cx="11.5" cy="11" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function isWindowsDriveRoot(directory: string): boolean {
  return /^[a-zA-Z]:[\\/]?$/.test(directory);
}

function DirectoryColumn({ listing, selectedPath, disabled, onPick, label }: {
  listing: DirectoryListing;
  selectedPath?: string;
  disabled: boolean;
  onPick: (entry: DirectoryEntry) => void;
  label: string;
}) {
  const { t } = useI18n();
  const entries = listing.drives ?? listing.directories;
  return (
    <section className="directory-picker-column" aria-label={label}>
      <div className="directory-picker-column-heading">
        <span>{label}</span>
        <span title={listing.path}>{listing.path || t("directoryPicker.drives")}</span>
      </div>
      <div className="directory-picker-list">
        {entries.map((entry) => (
          <button key={entry.path} className="directory-picker-entry" type="button" disabled={disabled} onClick={() => onPick(entry)} title={entry.path} aria-pressed={entry.path === selectedPath}>
            {listing.drives ? <DriveIcon /> : <FolderIcon />}
            <span>{entry.name}</span>
            <span aria-hidden="true">›</span>
          </button>
        ))}
        {entries.length === 0 && <div className="directory-picker-empty">{t(listing.drives ? "directoryPicker.noDrives" : "directoryPicker.noSubdirectories")}</div>}
      </div>
    </section>
  );
}

function CreateDirectoryDialog({ parent, onCancel, onCreated }: {
  parent: string;
  onCancel: () => void;
  onCreated: (path: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const composingRef = useRef(false);
  const mountedRef = useRef(true);
  const dialogRef = useModalDialog<HTMLDivElement>({ onClose: () => { if (!creatingRef.current) onCancel(); } });
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creatingRef.current || composingRef.current || !name.trim()) return;
    creatingRef.current = true;
    dialogRef.current?.focus();
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/cwd/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent, name }),
      });
      const data = await response.json() as { path?: string; error?: string; code?: string };
      if (!response.ok || data.error || !data.path) throw new Error(formatApiError({ ...data, error: data.error ?? `HTTP ${response.status}` }));
      if (mountedRef.current) onCreated(data.path);
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      creatingRef.current = false;
      if (mountedRef.current) setCreating(false);
    }
  };

  return (
    <div className="directory-picker-backdrop directory-picker-create-backdrop" onClick={(event) => {
      if (event.target === event.currentTarget && !creatingRef.current) onCancel();
    }}>
      <div className="directory-picker-panel directory-picker-create-panel" ref={dialogRef} role="dialog" aria-modal="true" aria-label={t("directoryPicker.newFolder")} tabIndex={-1}>
        <form onSubmit={(event) => void create(event)}>
          <div className="directory-picker-create-body">
            <h3>{t("directoryPicker.newFolder")}</h3>
            <p>{t("directoryPicker.createIn")}<strong>{parent}</strong></p>
            <input className="directory-picker-path" value={name} disabled={creating} autoFocus autoComplete="off" spellCheck={false} aria-label={t("directoryPicker.folderName")} placeholder={t("directoryPicker.folderName")}
              onChange={(event) => { setName(event.target.value); setError(null); }}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
              }}
            />
            {error && <div className="directory-picker-error" role="alert">{error}</div>}
          </div>
          <div className="directory-picker-footer">
            <button className="directory-picker-action" type="button" disabled={creating} onClick={onCancel}>{t("directoryPicker.cancel")}</button>
            <button className="directory-picker-action directory-picker-primary" type="submit" disabled={creating || !name.trim()}>{t(creating ? "directoryPicker.creatingFolder" : "directoryPicker.createFolder")}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface Props {
  onCancel: () => void;
  onSelect: (path: string, launchConfig?: { profile?: string; advisor?: boolean; extraArgs?: string[] }) => void;
  busy?: boolean;
  error?: string | null;
}

export function DirectoryPicker({ onCancel, onSelect, busy = false, error }: Props) {
  const { t } = useI18n();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [view, setView] = useState<DirectoryView | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creationParent, setCreationParent] = useState<string | null>(null);
  const currentPath = view?.child?.path ?? view?.level.path ?? "";
  const parentDirectory = view?.child?.parentPath ?? view?.level.parentPath ?? null;
  const navigationRef = useRef({ id: 0, controller: null as AbortController | null });
  const composingRef = useRef(false);
  const [profile, setProfile] = useState("");
  const [advisor, setAdvisor] = useState(false);
  const [extraArgs, setExtraArgs] = useState("");
  const [loading, setLoading] = useState(true);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneId, setCloneId] = useState<string | null>(null);
  const [cloneLog, setCloneLog] = useState("");
  const [cloneStatus, setCloneStatus] = useState<string | null>(null);
  const cloneAbortRef = useRef<AbortController | null>(null);
  const cloneRespondedRef = useRef(false);
  const cloneLogRef = useRef<HTMLPreElement>(null);
  const breadcrumbsRef = useRef<HTMLElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const creationOpenerRef = useRef<HTMLButtonElement | null>(null);
  const cloning = cloneId !== null;
  const locked = busy || cloning || creationParent !== null;
  const dialogRef = useModalDialog<HTMLDivElement>({
    onClose: () => { if (!locked) onCancel(); },
    active: portalTarget !== null,
  });

  const invalidateNavigation = useCallback(() => {
    navigationRef.current.id += 1;
    navigationRef.current.controller?.abort();
    navigationRef.current.controller = null;
  }, []);

  const beginNavigation = useCallback(() => {
    invalidateNavigation();
    const controller = new AbortController();
    navigationRef.current.controller = controller;
    setLoading(true);
    setLoadError(null);
    return { id: navigationRef.current.id, controller };
  }, [invalidateNavigation]);

  const navigateTo = useCallback(async (directory?: string) => {
    const { id, controller } = beginNavigation();
    try {
      const target = await loadDirectories(directory, controller.signal);
      if (id !== navigationRef.current.id) return;
      let next: DirectoryView = { level: target, selected: null, child: null };
      if (target.parentPath) {
        try {
          const parent = await loadDirectories(target.parentPath, controller.signal);
          const entry = parent.directories.find((entry) => comparableProjectPath(entry.path) === comparableProjectPath(target.path));
          if (entry) next = { level: parent, selected: entry, child: target };
        } catch {
          // A readable target remains usable when its parent cannot be listed.
        }
      }
      if (id !== navigationRef.current.id) return;
      setView(next);
      setPathInput(target.path);
    } catch (cause) {
      if (id === navigationRef.current.id) setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (id === navigationRef.current.id) setLoading(false);
    }
  }, [beginNavigation]);

  const selectDirectory = useCallback(async (entry: DirectoryEntry, level: DirectoryListing) => {
    if (view?.level === level && view.selected?.path === entry.path) {
      invalidateNavigation();
      setLoading(false);
      setLoadError(null);
      setView({ level, selected: null, child: null });
      setPathInput(level.path);
      return;
    }
    const { id, controller } = beginNavigation();
    setPathInput(entry.path);
    try {
      const child = await loadDirectories(entry.path, controller.signal);
      if (id !== navigationRef.current.id) return;
      setView({ level, selected: entry, child });
      setPathInput(child.path);
    } catch (cause) {
      if (id === navigationRef.current.id) setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (id === navigationRef.current.id) setLoading(false);
    }
  }, [beginNavigation, invalidateNavigation, view]);

  useEffect(() => {
    setPortalTarget(document.body);
    void navigateTo();
    return invalidateNavigation;
  }, [navigateTo, invalidateNavigation]);

  // Unmounting mid-clone drops the stream; the server cancels and cleans up.
  useEffect(() => () => cloneAbortRef.current?.abort(), []);

  useEffect(() => {
    const log = cloneLogRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [cloneLog]);

  useEffect(() => {
    const trail = breadcrumbsRef.current;
    if (trail) trail.scrollLeft = trail.scrollWidth;
  }, [currentPath]);

  // Let the shared modal hook remember the external opener before moving focus.
  useEffect(() => {
    if (portalTarget) pathInputRef.current?.focus();
  }, [portalTarget]);

  useEffect(() => {
    const opener = creationOpenerRef.current;
    if (creationParent !== null || !opener) return;
    creationOpenerRef.current = null;
    // Successful creation starts navigation while the New folder button is disabled.
    if (opener.isConnected && !opener.disabled) opener.focus();
    else pathInputRef.current?.focus();
  }, [creationParent]);

  const handlePathSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (composingRef.current || locked) return;
    const candidate = pathInput.trim();
    if (candidate) void navigateTo(candidate);
  };
  const hasUncommittedPath = pathInput.trim() !== currentPath;
  const cloneName = cloneUrl.trim() ? cloneDirectoryName(cloneUrl) : null;
  const cloneTarget = cloneName && currentPath ? `${currentPath.replace(/[\\/]+$/, "")}${currentPath.includes("\\") ? "\\" : "/"}${cloneName}` : null;
  const canSelect = Boolean(currentPath) && !hasUncommittedPath && !loading && !locked && (!cloneUrl.trim() || cloneName !== null);
  const canNavigateUp = Boolean(parentDirectory) || isWindowsDriveRoot(currentPath);
  const submitSelection = async () => {
    if (!canSelect) return;
    const args = extraArgs.split("\n").map((arg) => arg.trim()).filter(Boolean);
    const launchConfig = { profile: profile.trim() || undefined, advisor: advisor || undefined, extraArgs: args.length ? args : undefined };
    if (!cloneUrl.trim()) {
      onSelect(currentPath, launchConfig);
      return;
    }
    const id = crypto.randomUUID();
    const abort = new AbortController();
    cloneAbortRef.current = abort;
    cloneRespondedRef.current = false;
    setCloneId(id);
    setCloneLog("");
    setCloneStatus(t("directoryPicker.cloning"));
    try {
      const response = await fetch("/api/projects/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, parent: currentPath, url: cloneUrl.trim() }),
        signal: abort.signal,
      });
      cloneRespondedRef.current = true;
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({})) as { error?: string; code?: string };
        setCloneStatus(formatApiError({ ...data, error: data.error ?? `HTTP ${response.status}` }));
        return;
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffered = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += value;
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const frame = JSON.parse(line) as { type: string; text?: string; path?: string; error?: string; code?: string };
          if (frame.type === "output") setCloneLog((log) => appendProgress(log, frame.text ?? ""));
          else if (frame.type === "done" && frame.path) {
            setCloneStatus(t("directoryPicker.cloneSucceeded", { path: frame.path }));
            // If registering fails, "Select this folder" can retry on the clone.
            setCloneUrl("");
            void navigateTo(frame.path);
            onSelect(frame.path, launchConfig);
            return;
          } else if (frame.type === "cancelled") {
            setCloneStatus(t("directoryPicker.cloneCancelled", { path: frame.path ?? "" }));
            return;
          } else if (frame.type === "error") {
            setCloneStatus(formatApiError(frame));
            return;
          }
        }
      }
      setCloneStatus(t("directoryPicker.cloneInterrupted"));
    } catch (cause) {
      if (!abort.signal.aborted) setCloneStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      cloneAbortRef.current = null;
      setCloneId(null);
    }
  };
  const cancelClone = () => {
    if (!cloneId) return;
    setCloneStatus(t("directoryPicker.cloneCancelling"));
    const dropStream = () => {
      // Nothing was created yet (or the server cleans up on disconnect).
      setCloneStatus(t("directoryPicker.cloneCancelled", { path: cloneTarget ?? "" }));
      cloneAbortRef.current?.abort();
    };
    // Once the POST has responded, the stream stays open to report the cleanup
    // (a 404 then means the clone is already finishing and reports itself).
    // A 404 before that means the server has not registered the clone yet, so
    // drop the POST: the server cancels it on disconnect before or during git.
    void fetch("/api/projects/clone", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cloneId }) })
      .then((response) => { if (response.status === 404 && !cloneRespondedRef.current) dropStream(); }, dropStream);
  };

  if (!portalTarget) return null;

  return createPortal(
    <>
    <div className="directory-picker-backdrop animate-fade-in" onClick={(event) => {
      if (event.target === event.currentTarget && !locked) onCancel();
    }}>
      <div className="directory-picker-panel animate-scale-in" ref={dialogRef} role="dialog" aria-modal="true" aria-label={t("directoryPicker.selectDirectory")} aria-hidden={creationParent !== null || undefined} inert={creationParent !== null} tabIndex={-1}>
        <header className="directory-picker-header">
          <h2>{t("directoryPicker.selectDirectory")}</h2>
          <button className="directory-picker-action directory-picker-close" type="button" onClick={onCancel} disabled={locked} aria-label={t("directoryPicker.close")}>×</button>
        </header>

        <nav className="directory-picker-breadcrumbs" ref={breadcrumbsRef} aria-label={t("directoryPicker.breadcrumbs")}>
          {view?.level.drives && <button className="directory-picker-action" type="button" disabled={locked} onClick={() => void navigateTo()}>{t("directoryPicker.drives")}</button>}
          {getDirectoryBreadcrumbs(currentPath).map((crumb, index, crumbs) => (
            <span key={crumb.path}>
              {index > 0 && <span aria-hidden="true">›</span>}
              <button className="directory-picker-action" type="button" disabled={locked} aria-current={index === crumbs.length - 1 ? "location" : undefined} onClick={() => void navigateTo(crumb.path)} title={crumb.path}>{crumb.name}</button>
            </span>
          ))}
        </nav>

        <div className="directory-picker-body">
        <form className="directory-picker-path-form" onSubmit={handlePathSubmit}>
          <button className="directory-picker-action directory-picker-back" type="button" onClick={() => void navigateTo(parentDirectory ?? undefined)} disabled={locked || !canNavigateUp} title={t("directoryPicker.goToParent")} aria-label={t("directoryPicker.goToParent")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6" /></svg>
          </button>
          <input className="directory-picker-path" ref={pathInputRef} id="directory-path" type="text" value={pathInput} disabled={locked} aria-label={t("directoryPicker.directoryPath")} placeholder={t("directoryPicker.pathPlaceholder")} autoComplete="off" spellCheck={false}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
            }}
            onChange={(event) => {
              invalidateNavigation();
              setLoading(false);
              setPathInput(event.target.value);
              setLoadError(null);
            }}
          />
          <button className="directory-picker-action" type="submit" disabled={locked || !pathInput.trim()} title={t("directoryPicker.goToDirectory")}>{t("directoryPicker.go")}</button>
        </form>

        <div className="directory-picker-browser" aria-busy={loading}>
          <div className="directory-picker-columns">
            {view && <DirectoryColumn listing={view.level} selectedPath={view.selected?.path} disabled={locked} label={t("directoryPicker.currentLevel")} onPick={(entry) => void selectDirectory(entry, view.level)} />}
            {view?.child && <DirectoryColumn listing={view.child} disabled={locked} label={t("directoryPicker.selectedChildren")} onPick={(entry) => void selectDirectory(entry, view.child!)} />}
          </div>
          {loading && <div className="directory-picker-loading" role="status">{t("directoryPicker.loadingDirectories")}</div>}
          {(loadError || error) && <div className="directory-picker-error" role="alert">
            <span>{loadError ?? error}</span>
            {loadError && <button className="directory-picker-action" type="button" disabled={locked} onClick={() => void navigateTo(pathInput.trim() || currentPath || undefined)}>{t("directoryPicker.retry")}</button>}
          </div>}
        </div>

        <div className="directory-picker-options">
          <details>
            <summary>{t("directoryPicker.cloneOptions")}{cloneUrl.trim() ? " •" : ""}</summary>
            <div className="directory-picker-option-fields">
              <input className="directory-picker-clone-url" type="text" value={cloneUrl} disabled={locked} onChange={(event) => { setCloneUrl(event.target.value); setCloneStatus(null); }} placeholder={t("directoryPicker.cloneUrlPlaceholder")} aria-label={t("directoryPicker.cloneUrlLabel")} autoComplete="off" spellCheck={false} />
              {cloneUrl.trim() && !cloning && !cloneStatus && <div className="directory-picker-note">{cloneTarget ? t("directoryPicker.cloneInto", { path: cloneTarget }) : t("errors.invalid_git_url")}</div>}
              {cloneStatus && <div className="directory-picker-note" role="status">{cloneStatus}</div>}
              {cloneLog && <pre className="directory-picker-clone-log" ref={cloneLogRef} aria-label={t("directoryPicker.cloneOutputLabel")} tabIndex={0}>{cloneLog.replace(/\r/g, "")}</pre>}
            </div>
          </details>
          <details>
            <summary>{t("directoryPicker.launchOptions")}{profile.trim() || advisor || extraArgs.trim() ? " •" : ""}</summary>
            <div className="directory-picker-option-fields">
              <input className="directory-picker-profile" value={profile} disabled={locked} onChange={(event) => setProfile(event.target.value)} placeholder={t("directoryPicker.profilePlaceholder")} aria-label={t("directoryPicker.profileLabel")} />
              <label className="directory-picker-launch"><input type="checkbox" checked={advisor} disabled={locked} onChange={(event) => setAdvisor(event.target.checked)} />{t("projectLaunchConfig.advisorLabel")}</label>
              <textarea className="directory-picker-extra-args" value={extraArgs} disabled={locked} onChange={(event) => setExtraArgs(event.target.value)} placeholder={t("directoryPicker.extraArgsPlaceholder")} aria-label={t("directoryPicker.extraArgsLabel")} rows={2} />
            </div>
          </details>
        </div>
        </div>
        <div className="directory-picker-selection" aria-live="polite">
          <span>{t("directoryPicker.selectedDirectory")}</span>
          <strong>{currentPath || t("directoryPicker.noSelection")}</strong>
        </div>
        <footer className="directory-picker-footer">
          <button className="directory-picker-action directory-picker-new-folder" type="button" disabled={!currentPath || hasUncommittedPath || loading || locked} onClick={(event) => {
            creationOpenerRef.current = event.currentTarget;
            setCreationParent(currentPath);
          }}>{t("directoryPicker.newFolder")}</button>
          {cloning ? (
            <button className="directory-picker-action" type="button" autoFocus onClick={cancelClone}>{t("directoryPicker.cancelClone")}</button>
          ) : (
            <button className="directory-picker-action" type="button" onClick={onCancel} disabled={busy}>{t("directoryPicker.cancel")}</button>
          )}
          <button className="directory-picker-action directory-picker-primary" type="button" onClick={() => void submitSelection()} disabled={!canSelect} title={hasUncommittedPath ? t("directoryPicker.openPathBeforeSelecting") : cloneTarget ? t("directoryPicker.cloneInto", { path: cloneTarget }) : t("directoryPicker.selectCurrentDirectory")}>
            {busy ? t("directoryPicker.checking") : cloning ? t("directoryPicker.cloning") : cloneUrl.trim() ? t("directoryPicker.cloneHere") : t("directoryPicker.selectThisFolder")}
          </button>
        </footer>
      </div>
    </div>
    {creationParent !== null && <CreateDirectoryDialog parent={creationParent} onCancel={() => setCreationParent(null)} onCreated={(path) => {
      setCreationParent(null);
      setPathInput(path);
      void navigateTo(path);
    }} />}
    </>,
    portalTarget,
  );
}
