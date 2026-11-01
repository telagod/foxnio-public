# Desktop packaging

foxnio's desktop build is a **desktop launcher around the existing local server**. It is not a mobile Agent runtime and it does not bundle `omp` yet.

## Local build

Requirements:

- Node.js `>= 24` for the packaged server runtime;
- `omp` installed for the target machine and available on `PATH`, or `OMP_WEB_OMP_BIN` set to its executable;
- a native build host for the target operating system (this keeps `sharp` and the bundled Node runtime on the correct platform and architecture).

Build the installer on the machine/runner that matches the target:

```bash
npm ci
npm run desktop:dist
```

Artifacts are written to `dist-desktop/`:

- Windows: NSIS installer and portable executable;
- macOS: DMG and ZIP;
- Linux: AppImage and Debian package.

The installer includes only the production `.next` output: Next.js development output, webpack caches, build traces, and type-check artifacts are excluded. Runtime-traced `lib/` assets and `public/` static assets are retained. Dependency source maps are excluded from desktop packages; they are not loaded by the app at runtime, and `productionBrowserSourceMaps` is disabled.

The build bundles a standalone Node.js executable copied from `OMP_WEB_NODE_BIN`, or from the Node.js executable running `desktop:prepare-runtime`. The Electron process itself is **never** used to run `bin/omp-web.js`; the launcher selects this Node.js `>=24` runtime explicitly. If no suitable runtime is available, packaging fails.

The `omp` executable is deliberately external for this first desktop release. This keeps provider credentials, native Agent distribution, and platform-specific `omp` licensing/versioning separate from foxnio. Set `OMP_WEB_OMP_BIN` before launching the desktop app when `omp` is not on the GUI process's `PATH`.

## Targets and CI

The configured first-party CI targets are Windows x64, macOS x64/arm64, and Linux x64. Add Windows/Linux arm64 only after a matching native runner is configured; this packaging flow intentionally builds the bundled Node.js runtime on the same host and architecture as the installer.

Build each target on a matching GitHub Actions runner. Do not cross-copy a Linux Node binary into a Windows or macOS installer, and do not reuse a `node_modules` tree across operating systems: `sharp` is native and must be installed on the build runner for the target. Code signing and notarization are intentionally not configured in this repository; provide the platform credentials in CI before publishing public installers.

## Mobile boundary

Android and iOS use the existing authenticated PWA as a remote client. They connect over HTTPS to a foxnio server running on a desktop or server host. The mobile client does not run Node.js, `omp`, git, or the local workspace. A future Play Store/App Store wrapper can reuse this PWA, but it will remain a remote client unless a separate mobile Agent runtime is designed and distributed.
