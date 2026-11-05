export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
}

export type ToolPreset = "none" | "default" | "full";

export function isToolPreset(value: unknown): value is ToolPreset {
  return value === "none" || value === "default" || value === "full";
}

export const PRESET_NONE: string[] = [];
export const PRESET_DEFAULT: string[] = ["read", "bash", "edit", "write"];
export const PRESET_FULL: string[] = ["bash", "read", "edit", "write", "grep", "find", "ls"];
export type ToolPresetStatus = ToolPreset | "custom";

function classifyToolNames(toolNames: readonly string[]): ToolPresetStatus {
  const names = toolNames.map((name) => name.trim().toLowerCase());
  if (names.length === 0) return "none";
  if (names.length === PRESET_DEFAULT.length && PRESET_DEFAULT.every((name) => names.includes(name))) return "default";
  if (names.length === PRESET_FULL.length && PRESET_FULL.every((name) => names.includes(name))) return "full";
  return "custom";
}

/** Identify the effective OMP tool preset for the arguments used to spawn a child. */
export function getToolPresetStatus(
  toolNames?: readonly string[],
  extraArgs: readonly string[] = [],
  unspecifiedPreset: ToolPresetStatus | null = "full",
): ToolPresetStatus | null {
  let extraPreset: ToolPresetStatus | undefined;
  for (let i = 0; i < extraArgs.length; i += 1) {
    const arg = extraArgs[i];
    if (arg === "--no-tools") {
      extraPreset = "none";
    } else if (arg.startsWith("--tools=")) {
      extraPreset = classifyToolNames(arg.slice("--tools=".length).split(",").filter(Boolean));
    } else if (arg === "--tools") {
      const value = extraArgs[i + 1];
      extraPreset = value && !value.startsWith("--")
        ? classifyToolNames(value.split(",").filter(Boolean))
        : "custom";
      if (value && !value.startsWith("--")) i += 1;
    }
  }
  if (extraPreset) return extraPreset;
  return toolNames === undefined ? unspecifiedPreset : classifyToolNames(toolNames);
}


export function getToolNamesForPreset(preset: ToolPreset): string[] | undefined {

  if (preset === "none") return [...PRESET_NONE];
  if (preset === "full") return undefined;
  return [...PRESET_DEFAULT];
}
