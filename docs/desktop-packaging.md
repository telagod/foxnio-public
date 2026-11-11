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

- Windows: NSIS installer (`foxnio-Setup-<version>-win-x64.exe`) and portable executable (`foxnio-<version>-win-x64-portable.exe`). The two use different `artifactName` patterns because electron-builder falls back to the global pattern for every target, which would make them overwrite each other and leave `latest.yml` describing whichever was written last;
- macOS: DMG and ZIP;
- Linux: AppImage and Debian package.

The installer includes only the production `.next` output: Next.js development output, webpack caches, build traces, and type-check artifacts are excluded. Runtime-traced `lib/` assets and `public/` static assets are retained. Test files (`*.test.*`) are excluded from the app. Dependency source maps are excluded from desktop packages; they are not loaded by the app at runtime, and `productionBrowserSourceMaps` is disabled. Chromium keeps only the locale packs the UI offers (`en-US`, `ja`, `zh-CN`) instead of all 55. Package sources that `.next` already compiles into the static bundle (`mermaid`, `katex`, `lucide-react`, `@base-ui`, `react-syntax-highlighter`, `cytoscape`, `es-toolkit`, …) and the build-only SWC binary are excluded as well: the server's runtime imports are exactly the externals listed in `.next/server/**/*.nft.json`, and `bin/omp-web.js` starts Next with `--experimental-next-config-strip-types`, so Node ≥24 strips the types of `next.config.ts` itself instead of loading SWC. Without that flag a package that lacks `@next/swc-*` downloads it into `~/.cache/next-swc` on first run and fails offline — keep the flag in sync with any change to how the server boots. On Linux x64 the AppImage builds at 148 MB instead of 194 MB, and the unpacked app at 554 MB instead of 758 MB.

The history worker is a separate runtime entrypoint, not a compiled Next chunk.
Keep `lib/session-history-worker.mjs`, its `lib/**/*.ts` dependencies and `jiti`
in every desktop package; excluding `jiti` makes saved conversation reads fail.

The build bundles a standalone Node.js executable copied from `OMP_WEB_NODE_BIN`, or from the Node.js executable running `desktop:prepare-runtime`. The Electron process itself is **never** used to run `bin/omp-web.js`; the launcher selects this Node.js `>=24` runtime explicitly. If no suitable runtime is available, packaging fails.

The `omp` executable is deliberately external for this first desktop release. This keeps provider credentials, native Agent distribution, and platform-specific `omp` licensing/versioning separate from foxnio. Set `OMP_WEB_OMP_BIN` before launching the desktop app when `omp` is not on the GUI process's `PATH`.

## Runtime behavior

- The app starts its own local server on `127.0.0.1:30177`. The stable port keeps browser storage (UI preferences) in one origin. When the port is taken, for example by a CLI or service instance, the app uses the next free port (up to 30196) and logs it. A port set through `OMP_WEB_DESKTOP_PORT` (or `PORT`) is used as given and the app refuses to start if it is busy. The app also stops with an error when its server process exits before answering, instead of attaching to another server on that port.
- The in-app updater is disabled (`OMP_WEB_DISABLE_AUTOUPDATE=1` in the server environment) because it would stop the server process the desktop app owns. Install a newer installer to update.
- Links leaving the app open in the default browser or mail client only for `http:`, `https:` and `mailto:`; every other scheme (for example `file:`) is ignored.

## Targets and CI

The configured first-party CI targets are Windows x64, macOS x64/arm64, and Linux x64. Add Windows/Linux arm64 only after a matching native runner is configured; this packaging flow intentionally builds the bundled Node.js runtime on the same host and architecture as the installer.

Build each target on a matching GitHub Actions runner. Do not cross-copy a Linux Node binary into a Windows or macOS installer, and do not reuse a `node_modules` tree across operating systems: `sharp` is native and must be installed on the build runner for the target. Code signing and notarization are intentionally not configured in this repository, so the installers are unsigned (Windows SmartScreen warns; on macOS use right-click **Open** or `xattr -dr com.apple.quarantine /Applications/foxnio.app`). Provide the platform credentials in CI before publishing installers to a wider audience.

The desktop workflow uploads only installers, blockmaps and update metadata (not the `*-unpacked` build directories) as workflow artifacts kept for 7 days. On `v*` tags a separate `release` job, the only one with `contents: write`, attaches them to the GitHub Release. macOS does not upload `latest-mac.yml`: the arm64 and x64 builds write the same file name and the app has no auto-update consumer for it. See [`release.md`](./release.md) for the interplay with the package workflow.

## Mobile boundary

Android and iOS use the existing authenticated PWA as a remote client. They connect over HTTPS to a foxnio server running on a desktop or server host. The mobile client does not run Node.js, `omp`, git, or the local workspace. A future Play Store/App Store wrapper can reuse this PWA, but it will remain a remote client unless a separate mobile Agent runtime is designed and distributed.
