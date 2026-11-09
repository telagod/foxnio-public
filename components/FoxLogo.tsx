import { FOX_LOGO_PATH, FOX_LOGO_VIEWBOX } from "@/lib/fox-logo";

// FOX mark supplied by the user. One even-odd path, so it recolors cleanly
// with currentColor while the cut-outs stay transparent.
export default function FoxLogo({
  size = 28,
  className,
  label,
}: {
  size?: number;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={FOX_LOGO_VIEWBOX}
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      style={{ display: "block", flexShrink: 0 }}
    >
      <path d={FOX_LOGO_PATH} fill="currentColor" fillRule="evenodd" clipRule="evenodd" />
    </svg>
  );
}
