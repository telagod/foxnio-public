import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  {
    ignores: [".next/**", "dist-desktop/**", "desktop/runtime/**"],
  },
  {
    files: ["desktop/**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // React Compiler readiness rules (eslint-plugin-react-hooks 7.x; purity and
    // preserve-manual-memoization only started reporting with 7.1). The app does
    // not enable the compiler and relies on manual memoization, so these report
    // patterns that are correct for the runtime we ship.
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
