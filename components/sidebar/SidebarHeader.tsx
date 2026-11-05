"use client";

import { ArrowLeft, ArrowRight, MoreHorizontal, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import OmpWebLogo from "@/components/OmpWebLogo";
import { IconButton } from "./row-support";
import type { MenuAnchor, SidebarNavigation } from "./types";

/**
 * 48 px header: brand, back/forward (hidden below 240 px and on mobile), the
 * overflow menu trigger and the collapse / close button.
 */
export function SidebarHeader({ navigation, onClose, overflowOpen, onOpenOverflow }: {
  navigation?: SidebarNavigation;
  /** Collapses the sidebar (desktop) or closes the drawer (mobile). */
  onClose?: () => void;
  overflowOpen: boolean;
  onOpenOverflow: (anchor: MenuAnchor) => void;
}) {
  const { t } = useI18n();
  return (
    <header className="sb-header">
      {onClose && (
        <IconButton label={t("appShell.hideSidebar")} onClick={onClose} className="sb-header-close">
          <X size={16} strokeWidth={1.8} aria-hidden="true" />
        </IconButton>
      )}
      <span className="sb-brand">
        <OmpWebLogo size={20} />
        <span className="sb-brand-name">
          <span className="sb-brand-fox">fox</span>nio
        </span>
      </span>
      <span className="sb-header-actions">
        {navigation && (
          <span className="sb-nav">
            <IconButton
              label={t("sessionSidebar.navigateBack")}
              title={`${t("sessionSidebar.navigateBack")} (${navigation.backShortcut})`}
              disabled={!navigation.canBack}
              onClick={navigation.onBack}
            >
              <ArrowLeft size={15} strokeWidth={1.9} aria-hidden="true" />
            </IconButton>
            <IconButton
              label={t("sessionSidebar.navigateForward")}
              title={`${t("sessionSidebar.navigateForward")} (${navigation.forwardShortcut})`}
              disabled={!navigation.canForward}
              onClick={navigation.onForward}
            >
              <ArrowRight size={15} strokeWidth={1.9} aria-hidden="true" />
            </IconButton>
          </span>
        )}
        <IconButton
          label={t("sidebar.menu.more")}
          expanded={overflowOpen}
          onClick={(event) => onOpenOverflow({ element: event.currentTarget })}
        >
          <MoreHorizontal size={16} strokeWidth={2} aria-hidden="true" />
        </IconButton>
      </span>
    </header>
  );
}
