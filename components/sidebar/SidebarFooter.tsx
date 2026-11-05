"use client";

import type { ReactNode } from "react";
import { Archive, ChevronRight, Settings2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";

/**
 * Fixed footer outside the virtual list: archived sessions, a slot for the
 * provider usage bar, and the settings row with the update badge.
 */
export function SidebarFooter({ archivedCount, usage, settingsOpen, updateAvailable, onOpenArchive, onOpenSettings }: {
  /** Number of archived sessions; hidden while unknown. */
  archivedCount?: number;
  usage?: ReactNode;
  settingsOpen: boolean;
  updateAvailable: boolean;
  onOpenArchive: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useI18n();
  return (
    <footer className="sb-footer">
      <button type="button" className="sb-footer-row" title={t("sessionSidebar.archiveBrowserTitle")} onClick={onOpenArchive}>
        <Archive size={14} strokeWidth={1.9} aria-hidden="true" />
        <span className="sb-footer-label">{t("sessionSidebar.archiveBrowser")}</span>
        {archivedCount !== undefined && archivedCount > 0 && <span className="sb-count-chip">{archivedCount}</span>}
      </button>
      {usage}
      <button
        type="button"
        className="sb-footer-row"
        data-active={settingsOpen}
        aria-current={settingsOpen ? "page" : undefined}
        title={t("chatInput.settings")}
        onClick={onOpenSettings}
      >
        <span className="sb-settings-icon">
          <Settings2 size={14} strokeWidth={2} aria-hidden="true" />
          {updateAvailable && <span className="sb-update-badge" role="status" aria-label={t("skillsConfig.updateAvailable")} />}
        </span>
        <span className="sb-footer-label">{t("chatInput.settings")}</span>
        <ChevronRight className="sb-footer-chevron" size={13} strokeWidth={2} aria-hidden="true" />
      </button>
    </footer>
  );
}
