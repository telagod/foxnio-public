"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { planDefaultWorkspace } from "./workspace-selection";

export interface SelectedCwd {
  readonly cwd: string | null;
  /** Point the sidebar at a directory chosen by the user (or by the app on their behalf). */
  readonly select: (cwd: string | null) => void;
  /** Automatic pick; `provisional` when the ordering it came from was incomplete. */
  readonly pickAutomatically: (cwd: string, provisional: boolean) => void;
  readonly isProvisional: () => boolean;
}

/** The effective cwd of the sidebar: the directory New Session starts in and the explorer shows. */
export function useSelectedCwd(): SelectedCwd {
  const [cwd, setCwd] = useState<string | null>(null);
  const provisional = useRef(false);
  const select = useCallback((next: string | null) => {
    provisional.current = false;
    setCwd(next);
  }, []);
  const pickAutomatically = useCallback((next: string, isProvisional: boolean) => {
    provisional.current = isProvisional;
    setCwd(next);
  }, []);
  const isProvisional = useCallback(() => provisional.current, []);
  return { cwd, select, pickAutomatically, isProvisional };
}

export interface WorkspaceSyncOptions {
  readonly selection: SelectedCwd;
  /** The shell's own idea of the cwd (open session or pending new session). */
  readonly selectedCwdProp: string | null | undefined;
  readonly onCwdChange?: (cwd: string | null, projectRoot?: string | null) => void;
  readonly projectRootFor: (cwd: string | null) => string | null;
  /** Reveal a workspace in the list (clears an explicit fold). */
  readonly openWorkspace: (path: string) => void;
  /** First workspace in display order. */
  readonly topPath: string | null;
  readonly sessionsEmpty: boolean;
  readonly restorePending: boolean;
  readonly skipInitialSelection: boolean;
}

/** Keeps the sidebar's cwd and the shell's in step, and picks a workspace when none is selected. */
export function useWorkspaceSync(options: WorkspaceSyncOptions): void {
  const { selection, selectedCwdProp, onCwdChange, projectRootFor, openWorkspace } = options;
  const { cwd, select, pickAutomatically, isProvisional } = selection;

  // Tell the shell only when the effective cwd actually changes, not when
  // `projectRootFor` changes identity after a session or worktree refresh.
  const lastNotified = useRef<string | null>(null);
  useEffect(() => {
    if (lastNotified.current === cwd) return;
    lastNotified.current = cwd;
    onCwdChange?.(cwd, projectRootFor(cwd));
  }, [cwd, onCwdChange, projectRootFor]);

  // Follow the shell's cwd (a session picked outside the sidebar: URL restore,
  // command palette). Fires only when the prop changes, so a manual worktree
  // switch is not snapped back. A withdrawn value must not swallow the next one.
  const lastSynced = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedCwdProp) {
      lastSynced.current = null;
      return;
    }
    if (selectedCwdProp === lastSynced.current) return;
    lastSynced.current = selectedCwdProp;
    select(selectedCwdProp);
    const project = projectRootFor(selectedCwdProp);
    if (project) openWorkspace(project);
  }, [selectedCwdProp, projectRootFor, select, openWorkspace]);

  const { topPath, sessionsEmpty, skipInitialSelection } = options;
  // A cwd from the shell wins over the automatic pick; the effect above applies it.
  const restorePending = options.restorePending || Boolean(selectedCwdProp);
  useEffect(() => {
    const plan = planDefaultWorkspace({ selectedCwd: cwd, provisional: isProvisional(), topPath, sessionsEmpty, restorePending, skipInitialSelection });
    if (plan) pickAutomatically(plan.cwd, plan.provisional);
  }, [cwd, isProvisional, pickAutomatically, topPath, sessionsEmpty, restorePending, skipInitialSelection]);
}
