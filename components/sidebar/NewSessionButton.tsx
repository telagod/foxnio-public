"use client";

import { Plus } from "lucide-react";
import { useI18n } from "@/lib/i18n";

/** Primary action: 36 px on desktop, 44 px on touch; the hint shows the keyboard shortcut. */
export function NewSessionButton({ disabled, title, shortcutHint, onClick }: {
  disabled: boolean;
  /** Tooltip; explains the target directory, or why the button is disabled. */
  title?: string;
  shortcutHint?: string;
  onClick: () => void;
}) {
  const { t } = useI18n();
  return (
    <button type="button" className="sb-new-session" disabled={disabled} title={title} onClick={onClick}>
      <Plus size={15} strokeWidth={2.2} aria-hidden="true" />
      <span className="sb-new-session-label">{t("sessionSidebar.new")}</span>
      {shortcutHint && <kbd className="sb-kbd">{shortcutHint}</kbd>}
    </button>
  );
}
