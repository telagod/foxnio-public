"use client";

import React from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";

/**
 * Toolbar toggle between the compact composer and the full-screen editor. The
 * same button stays mounted in both modes so dialog focus restoration has a
 * live opener to return to.
 */
export function ComposerExpandButton({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const label = t(expanded ? "chatInput.collapseEditor" : "chatInput.expandEditor");
  const Icon = expanded ? Minimize2 : Maximize2;
  return (
    <button
      type="button"
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-haspopup={expanded ? undefined : "dialog"}
      data-testid="composer-expand-toggle"
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 28, height: 28, padding: 0,
        background: "none",
        border: "none",
        borderRadius: 7,
        color: "var(--text-muted)",
        cursor: "pointer",
        transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
    >
      <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
    </button>
  );
}
