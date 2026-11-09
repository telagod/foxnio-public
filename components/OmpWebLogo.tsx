import { FOX_LOGO_PATH, FOX_LOGO_VIEWBOX } from "@/lib/fox-logo";

// foxnio brand mark: the user-supplied angular fox head on the dark warm tile.
// Keep in sync with app/icon.svg, public/omp-web-logo.svg and the generated
// public/icon*.png / favicon.ico / omp-web.ico assets.
export default function OmpWebLogo({
  size = 20,
  label = "foxnio logo",
}: {
  size?: number;
  label?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={label}
      style={{ display: "block", flexShrink: 0, color: "#f2802e" }}
    >
      <rect width="64" height="64" rx="12" fill="#241810" />
      <svg x="10" y="6" width="44" height="52" viewBox={FOX_LOGO_VIEWBOX}>
        <path d={FOX_LOGO_PATH} fill="currentColor" fillRule="evenodd" />
      </svg>
    </svg>
  );
}
