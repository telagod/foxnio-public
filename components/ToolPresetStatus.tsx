"use client";

import { useId } from "react";
import { useI18n } from "@/lib/i18n";
import { PRESET_DEFAULT, type ToolPreset, type ToolPresetStatus } from "@/lib/tool-presets";

interface Props {
  selectedPreset: ToolPreset;
  activeToolset: { running: boolean; preset: ToolPresetStatus | null } | null;
  hasSession: boolean;
  onChange: (preset: ToolPreset) => void;
}

const PRESET_OPTIONS: Array<{ value: ToolPreset; labelKey: string }> = [
  { value: "full", labelKey: "chatInput.toolPresetFull" },
  { value: "default", labelKey: "chatInput.toolPresetDefault" },
  { value: "none", labelKey: "chatInput.toolPresetNone" },
];

export function ToolPresetStatus({ selectedPreset, activeToolset, hasSession, onChange }: Props) {
  const { t } = useI18n();
  const selectId = useId();
  const activePreset = activeToolset?.running ? activeToolset.preset : null;
  const currentText = activePreset === "full"
    ? t("toolPresetStatus.currentFull")
    : activePreset === "custom"
      ? t("toolPresetStatus.currentCustom")
      : activePreset === "none"
        ? t("toolPresetStatus.currentPreset", { preset: t("chatInput.toolPresetNone"), count: 0 })
        : activePreset === "default"
          ? t("toolPresetStatus.currentPreset", { preset: t("chatInput.toolPresetDefault"), count: PRESET_DEFAULT.length })
          : activeToolset?.running
            ? t("toolPresetStatus.currentUnknown")
            : activeToolset && hasSession
              ? t("toolPresetStatus.stopped")
              : hasSession
                ? t("toolPresetStatus.checking")
                : t("toolPresetStatus.newSession");
  const warnings: string[] = [];
  if (activePreset === "default") warnings.push(t("toolPresetStatus.currentDefaultWarning"));
  if (activePreset === "none") warnings.push(t("toolPresetStatus.currentNoneWarning"));
  if (activePreset === "custom") warnings.push(t("toolPresetStatus.currentCustomWarning"));
  if (selectedPreset === "default") warnings.push(t("toolPresetStatus.nextDefaultWarning"));
  if (selectedPreset === "none") warnings.push(t("toolPresetStatus.nextNoneWarning"));

  return (
    <section aria-label={t("toolPresetStatus.sectionLabel")} style={{ display: "grid", gap: 5, marginBottom: 7 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 10px", minHeight: 28, color: "var(--text-muted)", fontSize: 11 }}>
        <label htmlFor={selectId}>{t("toolPresetStatus.nextLabel")}</label>
        <select
          id={selectId}
          value={selectedPreset}
          onChange={(event) => onChange(event.target.value as ToolPreset)}
          style={{ maxWidth: "100%", minHeight: 28, padding: "3px 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", fontSize: 11 }}
        >
          {PRESET_OPTIONS.map((option) => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}
        </select>
        {hasSession && <span role="status" aria-live="polite">{currentText}</span>}
      </div>
      {warnings.map((warning, index) => (
        <div key={`${index}-${warning}`} role="alert" style={{ padding: "6px 9px", border: "1px solid color-mix(in srgb, var(--status-warning) 45%, var(--border))", borderRadius: "var(--radius-control)", background: "color-mix(in srgb, var(--status-warning) 10%, var(--bg))", color: "var(--text)", fontSize: 11, lineHeight: 1.45 }}>
          {warning}
        </div>
      ))}
    </section>
  );
}
