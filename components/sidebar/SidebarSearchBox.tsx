"use client";

import type { Ref } from "react";
import { Loader2, Search, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { IconButton } from "./row-support";

/**
 * Controlled search field. Escape clears a non-empty query; while the
 * transcript search streams, a Stop button replaces the idle state. The `/`
 * shortcut is handled by the container, which focuses `inputRef`.
 */
export function SidebarSearchBox({ value, searching, shortcutHint, inputRef, onChange, onStop }: {
  value: string;
  searching: boolean;
  /** Key hint shown while the field is empty and unfocused, e.g. "/". */
  shortcutHint?: string;
  inputRef?: Ref<HTMLInputElement>;
  onChange: (query: string) => void;
  onStop: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="sb-search" role="search">
      <Search className="sb-search-icon" size={14} strokeWidth={1.9} aria-hidden="true" />
      <input
        ref={inputRef}
        className="sb-search-input"
        type="text"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        maxLength={500}
        value={value}
        placeholder={t("sessionSidebar.searchPlaceholder")}
        aria-label={t("sessionSidebar.search")}
        title={t("sessionSidebar.searchTitle")}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || value === "") return;
          event.preventDefault();
          event.stopPropagation();
          onChange("");
        }}
      />
      {searching && (
        <button type="button" className="sb-search-stop" onClick={onStop}>
          <Loader2 className="sb-searching-icon" size={11} strokeWidth={2} aria-hidden="true" />
          {t("sessionSidebar.stopSearch")}
        </button>
      )}
      {value !== "" ? (
        <IconButton label={t("sidebar.search.clear")} className="sb-search-clear" onClick={() => onChange("")}>
          <X size={13} strokeWidth={2} aria-hidden="true" />
        </IconButton>
      ) : (
        shortcutHint && <kbd className="sb-kbd sb-search-kbd" aria-hidden="true">{shortcutHint}</kbd>
      )}
    </div>
  );
}
