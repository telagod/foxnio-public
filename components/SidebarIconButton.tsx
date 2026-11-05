"use client";

import { useState, type ReactNode, type Ref } from "react";

const TRANSITION = "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm), border-color var(--dur-fast) var(--ease-out-warm)";

/** Quiet square icon button for panel chrome. Stays visually subdued; the
 *  accent appears on hover and when active (e.g. an applied filter).
 *  `menuExpanded` makes it a menu trigger (aria-haspopup/aria-expanded instead
 *  of aria-pressed). */
export function SidebarIconButton({
  ref,
  label,
  title,
  onClick,
  active = false,
  menuExpanded,
  disabled = false,
  children,
}: {
  ref?: Ref<HTMLButtonElement>;
  label: string;
  title?: string;
  onClick: () => void;
  active?: boolean;
  menuExpanded?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      ref={ref}
      type="button"
      className="sidebar-icon-button"
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
      disabled={disabled}
      {...(menuExpanded === undefined
        ? { "aria-pressed": active }
        : { "aria-haspopup": "menu" as const, "aria-expanded": menuExpanded })}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, padding: 0, flexShrink: 0, lineHeight: 0,
        background: active || hovered ? "var(--bg-hover)" : "none",
        border: "none",
        borderRadius: "var(--radius-control)",
        color: active ? "var(--accent)" : hovered ? "var(--accent)" : "var(--text-dim)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: TRANSITION,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
    </button>
  );
}
