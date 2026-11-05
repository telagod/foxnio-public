"use client";

import { memo } from "react";
import { useI18n } from "@/lib/i18n";
import type { SidebarMoreRow } from "@/lib/sidebar-types";
import { RowFrame, frameLayout, rowPropsEqual, type RowBaseProps } from "./row-support";

export type MoreRowProps = RowBaseProps<SidebarMoreRow>;

function MoreRowView(props: MoreRowProps) {
  const { row, actions } = props;
  const { t } = useI18n();
  return (
    <RowFrame {...frameLayout(props)} kind="more">
      {row.hidden > 0 && (
        <button type="button" className="sb-more-btn" tabIndex={-1} onClick={() => actions.showMore(row.projectKey)}>
          {t("projects.showMoreSessions", { count: row.hidden })}
        </button>
      )}
      {row.canCollapse && (
        <button type="button" className="sb-more-btn sb-more-btn--less" tabIndex={-1} onClick={() => actions.showLess(row.projectKey)}>
          {t("projects.showLess")}
        </button>
      )}
    </RowFrame>
  );
}

export const MoreRow = memo(MoreRowView, rowPropsEqual);
