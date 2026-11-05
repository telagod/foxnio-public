"use client";

import { useRef, useState } from "react";

/**
 * Text input that replaces a row's label while renaming. Enter and blur commit
 * the trimmed value, Escape cancels; only the first of these takes effect.
 */
export function InlineEdit({ initial, label, onCommit, onCancel }: {
  initial: string;
  label: string;
  /** `viaKeyboard` is false when the input lost focus; the caller then must not pull focus back. */
  onCommit: (value: string, viaKeyboard: boolean) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const finished = useRef(false);

  const finish = (commit: boolean, viaKeyboard: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (commit) onCommit(value.trim(), viaKeyboard);
    else onCancel();
  };

  return (
    <input
      className="sb-inline-input"
      autoFocus
      aria-label={label}
      value={value}
      maxLength={200}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => finish(true, false)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true, true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(false, true);
        }
      }}
    />
  );
}
