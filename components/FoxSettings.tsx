"use client";

import { useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/primitives";
import type { ProjectBriefing } from "@/lib/briefing";
import type { useFoxService } from "@/hooks/useFoxService";
import { useI18n } from "@/lib/i18n";
import { comparableProjectPath } from "@/lib/comparable-path";
import type { FoxDispatchPolicy } from "@/lib/fox-service-config";

export function FoxSettings({ service, projects, onClose }: {
  service: ReturnType<typeof useFoxService>;
  projects: ProjectBriefing[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [saved, setSaved] = useState(false);
  const changed = useRef(new Set<string>());
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !service.saving) onClose(); }}>
      <DialogContent className="fox-settings-dialog" style={{ width: 600, maxWidth: "calc(100vw - 24px)" }}>
        <div className="fox-settings-heading">
          <DialogTitle>{t("fox.settings.title")}</DialogTitle>
          <DialogClose className="fox-button fox-icon-button" disabled={service.saving} aria-label={t("fox.detail.close")}><X size={18} /></DialogClose>
        </div>
        <p className="fox-settings-description">{t("fox.settings.description")}</p>
        {service.status && <p className={service.health === "error" ? "fox-inline-warning" : "fox-service-status"} role="status" data-health={service.health}>
          {service.health === "error"
            ? <span>{t("notifications.typeError")}: {service.status.lastRunError}</span>
            : t(`fox.service.${service.health}`)}
        </p>}
        {!service.status ? (
          <div className="fox-inline-warning" role="status">
            <span>{t(service.failed ? "fox.service.unavailable" : "fox.overview.loading")}</span>
            <button type="button" className="fox-button" onClick={() => void service.refresh()}>{t("fox.retry")}</button>
          </div>
        ) : (
          <form onChange={(event) => { if (event.target instanceof HTMLInputElement) changed.current.add(event.target.name); setSaved(false); }} onSubmit={async (event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const values = {
              enabled: data.get("enabled") === "on",
              quietStart: String(data.get("quietStart")),
              quietEnd: String(data.get("quietEnd")),
              maxDailyMessages: Number(data.get("maxDailyMessages")),
            };
            const patch = Object.fromEntries(Object.entries(values).filter(([name]) => changed.current.has(name)));
            const ok = Object.keys(patch).length === 0 || await service.update(patch);
            if (ok) changed.current.clear();
            setSaved(ok);
          }}>
            <fieldset disabled={service.saving}>
              <legend>{t("fox.settings.observation")}</legend>
              <label className="fox-settings-toggle"><input name="enabled" type="checkbox" defaultChecked={service.status.config.enabled} />{t("fox.settings.enabled")}</label>
              <p className="fox-settings-help">{t("fox.settings.observationHint")}</p>
              <p className="fox-settings-help">{t("fox.report.settingsHint")}</p>
              <div className="fox-settings-grid">
                <label>{t("fox.settings.quietStart")}<input name="quietStart" type="time" required defaultValue={service.status.config.quietStart} /></label>
                <label>{t("fox.settings.quietEnd")}<input name="quietEnd" type="time" required defaultValue={service.status.config.quietEnd} /></label>
                <label>{t("fox.settings.dailyCap")}<input name="maxDailyMessages" type="number" min={1} max={10} required defaultValue={service.status.config.maxDailyMessages} /></label>
              </div>
              <p className="fox-settings-help">{t("fox.settings.timezone")}</p>
              <div className="fox-settings-save">
                <button type="submit" className="fox-button fox-button-primary">{t(service.saving ? "fox.settings.saving" : "fox.settings.save")}</button>
                {saved && <span role="status"><Check size={14} />{t("fox.settings.saved")}</span>}
              </div>
            </fieldset>
            {service.error && <p className="fox-inline-warning" role="alert">{service.error}</p>}
          </form>
        )}
        {service.status && <section className="fox-native-policies">
          <h3>{t("fox.native.permissions")}</h3>
          <p className="fox-settings-help">{t("fox.native.permissionsHint")}</p>
          {projects.map((project) => <label key={project.key}>
            <span><strong>{project.name}</strong><small>{project.path}</small></span>
            <select disabled={service.saving} aria-label={t("fox.native.projectPermission", { project: project.path })}
              value={service.status?.projectPolicies?.[project.path] ?? service.status?.config.dispatchPolicies?.[project.policyKey ?? comparableProjectPath(project.path)] ?? "confirm"}
              onChange={(event) => void service.update({ dispatchPolicies: { [project.path]: event.target.value as FoxDispatchPolicy } })}>
              <option value="observe">{t("fox.native.policy.observe")}</option>
              <option value="confirm">{t("fox.native.policy.confirm")}</option>
              <option value="auto">{t("fox.native.policy.auto")}</option>
            </select>
          </label>)}
          {service.status.capabilities?.memoryTools === false && <p className="fox-native-source-warning">{t("fox.native.memoryUnavailable")}</p>}
          <p className="fox-settings-help">{t("fox.native.historyHint")}</p>
        </section>}
      </DialogContent>
    </Dialog>
  );
}
