# Changelog

This changelog tracks **foxnio** (`@telagod/foxnio`). Entries before `v0.6.2` are retained from the `ompweb` upstream history.

---

## [Unreleased]

### Fixes & Improvements

- **FOX can dispatch immediately after goal authorization.** The host binds and resumes the exact native goal before returning a successful authorization result, instead of exposing its temporary setup pause to the same model turn. Native RPC continuation still starts after settlement, and Pause/Stop and scoped admission checks remain enforced. Regression coverage now dispatches without an artificial post-authorization yield and verifies cancellation during binding.
- **Failed FOX activation stays fail-closed.** If the post-resume native state read fails, the host closes admission and pauses only the proven same goal, reporting any unconfirmed pause. An error cannot leave a claimed successful activation or silently permit dispatch.

## [0.7.1] - 2026-11-12

### Fixes & Improvements

- **Canonical filesystem aliases preserve session identity and authority.** Native indexing, targeted invalidation, parent lineage and FOX scope checks resolve macOS `/var` aliases and Windows short paths without granting access outside verified roots. File-index requests accept aliases only after physical containment checks.
- **FOX identity stays consistent across Windows short paths.** New grants and manual receipts use native canonical paths; old policy aliases resolve conservatively, conflicting aliases use the most restrictive policy, and worker reports must still prove the exact assigned project. Historical noncanonical grants require fresh authorization rather than being silently broadened.
- **Cross-platform regression fixtures use native paths.** Migration, backup and registry tests no longer assume POSIX path spelling or Windows support for POSIX permission bits; idle reaping tests use a deterministic clock.

> Upgrades from 0.6.x still require all old instances stopped and
> `foxnio data migrate --offline`; 0.7.0 databases do not need reimport.

## [0.7.0] - 2026-11-12

### Added

> **Upgrade requires offline migration.** Stop all old foxnio instances, then run
> `foxnio data migrate --offline` before starting this version. Original data is
> retained; see README for backup and restore instructions.

- **Unified application data and synchronization.** Project metadata, pins, notification history, FOX pointer and observation accounting now share a worker-owned SQLite database with transactional updates. One revisioned browser store replaces separate durable refresh loops; native OMP files and live execution remain authoritative. Existing installations require explicit offline migration; consistent backup and projection rebuild commands are available.
- **FOX can deliver an authorized goal autonomously.** One native scope confirmation enables OMP goal-driven delegation, evidence review, bounded rework and next steps with no browser open. The activity view links the native goal, todo, exact workers and criterion evidence, with Pause/Resume/Stop and original-question navigation. Defaults are four workers, 64 automatic dispatches and three reworks per item; no Chief database or second agent runtime is added.
- **Goal progress is separate from observation and notifications.** Quiet hours and observation limits do not stop authorized work. Dedicated in-app outcome/decision notices have their own daily limit while raw input/history signals remain intact. Existing global Agent tools disablement still blocks execution; old conversations receive no authority on upgrade.
- **omp release tracking.** A daily workflow checks every new omp release against foxnio: it runs foxnio's native omp tests against the released binary and opens an issue (label `omp-update`) with the result and what changed since the verified version (`.github/omp-version.json`): RPC commands and frames, CLI flags, settings, session format, changed files per area and the changelog.

### Fixes & Improvements

- **Storage recovery and lifecycle boundaries.** Initial databases are atomically published after commit, retained-copy damage is surfaced without blocking healthy data, and explicit cursor resets reconcile offline revision rollback. Resident startup retries after storage failures; shutdown drains durable notification writes before Next exits, with a bounded unsaved-data diagnostic.
- **Storage regressions run in the default CI suite.** `npm test` includes `lib/storage/*.test.mjs`, covering migration, WAL history, crash recovery, worker behavior and native indexing alongside existing tests.
- **Imported sessions appear before import success is returned.** The import endpoint waits for targeted native indexing instead of acknowledging only an asynchronous invalidation.
- **Native goal recovery preserves authority boundaries.** Exact grant receipts, complete native-family replay, fork isolation, monotonic revocation, evidence-gated completion and uncertain-delivery handling prevent old permissions or ambiguous reports from becoming new work. Model catalogs are restored before native resume, and report receipt/state queries share a serialized metadata path without treating independent continuation as report-triggered execution.
- **Session mutations honor native cross-process ownership.** Offline rename, delete and archive hold OMP's session lease inside an isolated maintenance process; older OMP versions without that capability fail closed. Failed live renames never fall back to direct writes. Parent sessions with children in other projects cannot be deleted or archived, preserving FOX worker lineage.
- **A missing session workspace stops execution.** Automatic recovery and explicit commands no longer fall back to the server directory or home. History stays readable; restore the original directory or start a new conversation in the intended workspace.
- **Read permission no longer grants native-state upload permission.** Generic uploads cannot overwrite OMP config, credentials, session or security state, including through symlinked roots or a home-directory workspace. Project MCP symlinks may target only files inside the project. Browser API Origin checks now compare the complete normalized origin; reverse proxies must preserve its port.
- **History parsing no longer blocks HTTP and SSE.** One bounded Node worker owns the existing history caches and handles cold scans, changed-file rebuilds, context/tree projection and pages. Worker failure rejects pending reads and later requests recover; unchanged cursor, compaction and blob contracts remain intact.
- **Desktop packages retain the history worker runtime.** `jiti` is shipped alongside the unbundled worker and its TypeScript dependencies; saved history reads are verified from the Linux unpacked app using its bundled Node runtime.
- **Browser state recovers and actions settle once.** Notification history reconciles on every SSE OPEN, including reconnect. Browser host actions claim ownership before execution, preventing duplicate effects across tabs and rejecting duplicate/late replies.
- **FOX failures are no longer mistaken for running work.** A failed idle conversation remains eligible for the existing observation loop, while health displays the native error until recovery; real running work and pending questions still block wakes.
- **FOX is native-first.** FOX keeps its plan in OMP's todo tool, rendered above the composer through `ComposerPanels`; questions use native `ask` through `ExtensionDialog`, durable preferences use OMP memory, and the session transcript is the audit trail. The SQLite `chief.db` control plane (tickets, approvals, autonomy, preferences, audit), its `/api/chief/*` routes, the Chief panel, the `dispatches.json` ledger and the second policy engine are deleted. Existing `chief.db`, `dispatches.json` and preference records stay on disk untouched; a one-time read-only migration copies only the project autonomy policy into `service.json` as `observe` / `confirm` / `auto`.
- **FOX uses omp's native memory tools.** Its resident toolset stays file-edit-free (`read`, `grep`, `glob`, `todo`, `ask`), and `recall`, `retain`, `reflect`, and `memory_edit` are supplied by OMP when a memory backend is configured. The persona tells FOX to recall before answering about prior context and to retain durable facts; when memory is unavailable FOX says so instead of falling back to another store.
- **FOX can now wake itself for new attention.** A server-side 60s observation tick reads the same read-only briefing, dedupes attention occurrences, respects default quiet hours (22:00–08:00) and a three-message daily cap, coalesces while FOX is busy, and delivers a normal prompt to the existing FOX OMP session through `startRpcSession`. It never starts a second runtime and never writes project state. The wake prompt is observe-only: it tells FOX not to dispatch or edit unless the user already asked. The FOX header toggles **Manual/Auto**; Auto is the opt-in for existing installs.
- **The FOX page and the resident service share one conversation.** The browser registers its FOX session with the server, and the server record is authoritative, including across tabs. The header's **New** action writes a reset epoch and revokes the old id, so an older saved browser id cannot revive the old conversation; the next prompt starts a fresh FOX session without deleting the old transcript. A failed wake keeps its events pending and retries up to three times without spending the daily cap.
- **The phone composer toolbar stays on one row.** The composer's controls use 36 px targets, the primary action becomes icon-only, and the model selector takes the remaining width, so the toolbar no longer wraps into two separate rows on phones.
- **The narrow-phone composer reserves two placeholder lines.** At ≤340 px the compact textarea is tall enough for the wrapped localized placeholder, so its second line is no longer clipped by the toolbar divider.
- **A stream-stall retry no longer shows up as a run failure.** omp can report the same prompt as `completed` after retrying internally; a failed response received mid-stream is held until `prompt_result` (a failure before the stream starts still notifies immediately), and the FOX brief hides unread errors that the live session or a later completion has already resolved.
- **The FOX sidebar brief shows live work and decisions.** The FOX page is chat-first; its right-side brief lists running sessions with the task they were started for, the exact pending question or error, project state, and recent snippets. Workers come from native `parentSession` lineage and live session state, never from a dispatch ledger. The same active sections are written into `BRIEFING.md` so FOX's own answers stay grounded.
- **FOX dispatches into explicit worker sessions.** The resident session never edits project code directly. New project work creates a dedicated worker with native `parentSession`; follow-ups require its exact session ID and cwd. Native hooks enforce project policy and single-use argument-bound receipts. Observation remains read-only; explicitly granted native-goal continuation is the separate authorized execution path.
- **The sidebar stops showing "waiting for input" once the dialog is gone.** The input notification is now marked read when the dialog is answered, expires, is cancelled, is auto-approved, or its session restarts, and opening a session clears leftovers — previously only the notification panel did, so answered questions kept advertising themselves.
- **The sidebar is one activity-sorted workspace list.** The separate Active section is gone: workspaces are ordered by their newest session, and only the selected workspace plus ones with running, waiting or unread sessions open by themselves — every other workspace stays folded instead of needing a manual collapse.
- **The sidebar's New Session button and the "new-session tools" status row are gone.** Sessions start from a workspace row's New session action or the command palette, and the tool preset stays selectable in the composer's + menu.
- **Desktop installers are about a quarter smaller.** Chromium now ships only the three locale packs the UI offers, and the app no longer bundles package sources that `.next` already compiles into the static bundle (`mermaid`, `katex`, `lucide-react`, `@base-ui`, `react-syntax-highlighter`, `cytoscape`, `es-toolkit`, …) or the build-only SWC binary. `next start` now passes `--experimental-next-config-strip-types`, so Node strips the types of `next.config.ts` itself; without it a package lacking `@next/swc-*` would download SWC on first run and fail offline. On Linux x64 the AppImage drops from 194 MB to 148 MB and the unpacked app from 758 MB to 554 MB.
- **Reopening a session that omp continued in another file no longer starts a second omp for it.** Since omp 18.13.2, resuming a session file opens the newest copy of the conversation (`continuationOf`), which happens after another omp process held the file. foxnio kept that child only under the copy's id, so every request for the original id spawned another omp on the same conversation and the chat's event stream answered "Session is not managed by foxnio". The requested id now stays an alias of the child, as for a live move.
- **Settings show and accept omp's newer values.** The approval mode **Ask and remember** (`always-ask-cached`) displayed as "Auto approve"; the advisor backlog `strict` and the `sharpshooter` memory backend read as unset. Unset settings now show omp's defaults (Autolearn and its auto-continue off, model fallback on, memory backend off), Bash approval can follow the approval mode again, and the advisor-for-subagents toggle uses `task.agentAdvisor.task`, the key omp migrates `advisor.subagents` to. The model roles list drops `designer`, which omp no longer has, and adds `memory` and `widget`.
- **Secret prompts from extensions are masked** (`secret: true` input dialogs, omp 18.13.2+).
- **A prompt refused by omp's cost cap shows omp's message** instead of leaving the composer busy (`session.maxCost` / `--max-cost`, omp 18.13+).
- **`nix build` works from a clean checkout.** `nix/package.nix` listed the git-ignored `next-env.d.ts` in its source set, so evaluating the flake failed on every checkout, v0.6.2 included.

---

## [v0.6.2] - 2026-11-06

The first published foxnio release. v0.6.1 was prepared but never published, so its changes are listed here as well.

### Upgrade

foxnio is published to GitHub Packages, which needs a classic personal access token with `read:packages` for every install. Map the `@telagod` scope once (npm asks for your GitHub username and takes the token as the password), then install:

```bash
npm login --scope=@telagod --auth-type=legacy --registry=https://npm.pkg.github.com
npm install -g @telagod/foxnio@0.6.2
```

The desktop installers attached to this release are not code-signed. Windows SmartScreen shows a warning; on macOS, open the app with right-click **Open** or run `xattr -dr com.apple.quarantine /Applications/foxnio.app`.

Coming from ompweb or omp-web: remove the old services, units and scheduled tasks by hand first. The README section "Moving from ompweb / omp-web" lists their names.

### Security

- **Exported session pages run in a sandbox.** "View full history" served the HTML that `omp --export` generates on the app origin, and that template does not escape raw HTML in messages, so a poisoned reply could script the API with your cookie (code execution as the server user). The export now carries `Content-Security-Policy: sandbox allow-scripts` (an opaque origin), its temp files are per request, and `omp --export` runs with the sanitized child environment.
- **Password-less installs reject foreign `Host` headers (DNS rebinding).** Without `OMP_WEB_PASSWORD_HASH` only loopback host names are served and anything else gets `403`; the new `OMP_WEB_ALLOWED_HOSTS` adds names for proxy, tunnel or Tailscale setups. The launcher no longer treats `127.example.com` as loopback.
- **Sign-in is throttled and no longer blocks the server.** Passwords are checked with asynchronous scrypt, at most two checks run at once, and five consecutive failures lock the client out (15 s, doubling up to 5 min, HTTP `429`). A non-object JSON body returns `400` instead of `500`.
- **`start:lan` now goes through the launcher**, which refuses a non-loopback bind without a password hash; `dev:lan` is removed.
- **Dependencies updated for 11 advisories** (`next` 16.4.5, `undici` 8.12.4, `sharp` 0.35.5, `dompurify`, `@xmldom/xmldom`, `source-map-js`; only low-severity KaTeX advisories remain). The unused Next image optimizer is disabled, so `/_next/image` no longer answers unauthenticated requests.
- **Config files keep owner-only permissions and cannot be overwritten with stale data.** `models.yml`, `config.yml`, `omp-web-settings.json`, model roles and `mcp.json` are written atomically with their existing mode (0600 for new files, symlinks preserved). `GET` responses hide stored API keys, secret headers and secret environment values behind a mask that saving restores. `models.yml` saves carry a revision (`409` on conflict, previous file kept as `models.yml.bak`); the settings dialogs send only the keys you changed, refuse to save after a failed load, and roll back when a save fails. `PUT /api/omp-settings` accepts known keys only (it used to pass whole sections through, including `compaction.remoteEndpoint` and `mnemopi.llmApiKey`). The agent-environment policy also blocks loader and interpreter hooks (`LD_*`, `DYLD_*`, `BASH_ENV`, `BUN_OPTIONS`, ...).
- **Reading git state no longer runs repository-controlled commands.** Read-only git calls disable `core.fsmonitor`, textconv and external diff, skip optional locks (no more `index.lock` clashes with the agent) and treat paths literally (a file named `*.txt` no longer shows other files' diffs).
- **The `/api/files` credential deny-list covers more**: SQLite sidecars such as `agent.db-wal`, `omp-web-settings.json`, the notification database, `web-auth-secret.json`, broker tokens and `mcp.json`. It checks the real path too, so a symlink cannot expose them.
- **Web Push registration only accepts real push services** (Google FCM, Mozilla, Apple, Windows; `OMP_WEB_PUSH_ALLOWED_HOSTS` extends the list), so a registered endpoint can no longer make the server call internal addresses, and push errors in API responses are generic.
- Child processes no longer inherit `OMP_WEB_STT_KEY` or any `OMP_WEB_*_KEY|TOKEN|SECRET|PASSWORD|HASH` variable; plugin and skill CLI arguments starting with `-` are rejected; the Windows service rejects hostnames and ports that could inject shell syntax; the update target must be a plain version string; the desktop app opens only `http`, `https` and `mailto` links outside the app.

### Added

- **The sidebar was rebuilt.** One flat, virtualized list with an **Active** section (sessions that are waiting for you, running, exited or unread, across all workspaces), a **Pinned** section and the workspaces. An open workspace shows its first five sessions and automatically keeps every running, waiting, unread or selected session visible; "Show 20 more" reveals the rest. Search is a flat ranked list (instant title/first-message/workspace matches, then transcript matches), rows have a context menu (right click, long press, `Shift+F10`), full keyboard navigation (arrows, `F2` rename, `Delete`, `p` pin) and `Ctrl/Cmd+B` toggles the sidebar. The resize handle supports pointer capture and the keyboard.
- **Pinned sessions**, stored on the server so every device sees them (`/api/session-ui`).
- **A real mobile drawer.** A `min(88vw, 360px)` sheet with a backdrop that you pull out from the left edge and that follows your finger; the file panel uses the same gesture. Every sidebar target is at least 44 px, menus become bottom sheets, and the layout follows the on-screen keyboard (`visualViewport`).
- New environment variables `OMP_WEB_ALLOWED_HOSTS` and `OMP_WEB_PUSH_ALLOWED_HOSTS`.
- **Desktop installers use the fork's executable name and include Linux package metadata.** Electron's Linux executable, desktop entry, AppImage, and Debian package are now named for foxnio, and the Debian package has its maintainer field.
- Desktop installers exclude Next.js development output, build caches, build traces, generated type-check artifacts, and dependency source maps, while retaining runtime-traced `lib/` assets and `public/` static assets.
- **Release distribution moved to GitHub Packages.** The `@telagod/foxnio` package is published to `npm.pkg.github.com`, and in-app version checks follow the repository's GitHub Releases instead of the public npm registry.
- **Full-screen composer editor and short previews of long sent messages.** An expand button in the composer toolbar opens the same draft (text, attachments, slash and `@` menus, draft recovery) in a near-full-screen dialog; Enter inserts a newline there and Ctrl/Cmd+Enter sends, Esc closes menus first and then collapses, and sending returns to the compact composer. Long sent messages now show a three-line preview with a "Show N more lines" toggle instead of a 300px scrolling box, live and in history. ([upstream #351](https://github.com/kahme247/ompweb/issues/351))
- **A finished turn collapses into one summary row above its final reply.** Thinking, tool calls, outputs and intermediate text fold into a single "Completed N steps · N tool calls · N thinking blocks · 2m 41s" row that expands to the full trajectory; the running turn stays as it was, and a turn with a provider error is left unfolded. Turn it off with the new **Fold completed turns** setting. ([upstream #354](https://github.com/kahme247/ompweb/issues/354))
- **Session tabs on desktop.** Sessions you open stay as tabs above the chat, so you can flip between them and keep an eye on several runs. Each tab shows the session title, a spinner while the agent runs, and a marker when it is waiting for your input; close with × or middle-click, drag (or Ctrl+Shift+←/→) to reorder, and `+` starts a new chat. Tabs are remembered per browser, each tab restores where you were reading, and closing one never stops the session. Turn them off in Settings → General → Session tabs. Phones keep the single-session view. ([upstream #353](https://github.com/kahme247/ompweb/issues/353))

### Fixes & Improvements

- **Resource use.** The session store replaces four separate `/api/sessions` fetchers and a second `running` subscription. Session file changes now update the list with small `?ids=` requests (at least 1.5 s apart) instead of reloading everything: with 3000 sessions, a 20 s append storm on one session went from 46 full 2.2 MB responses to 15 delta requests. The sidebar DOM no longer grows with the number of sessions (1472 nodes, and 9062 after expanding the largest workspace, down to about 430-620). Transcript search scans files without materializing lines (peak RSS 340 MiB down to 110 MiB on a heavy data set) and its cache has a size budget. The idle composer no longer polls `/api/stt` every 4 s, hidden tabs no longer poll agent state or provider usage, and a running session issues about half as many state requests while its stream is healthy.
- **Resumed sessions can reload again** (`/reload`, MCP enable/disable, plugin install). The tool-preset check refused every session opened from the sidebar.
- **A failed `send_to_session` no longer crashes the server**, `delivery: "followUp"` works, and nested waited deliveries respect the chain-depth cap.
- **The streaming reply shows tokens/s and hides its copy/fork actions while it streams**, and tool-call and markdown rendering no longer redo everything on every token.
- A prompt sent right before switching tabs is delivered instead of silently returning to the draft; host-tool, notification and running-indicator streams reconnect after a server error; Back/Forward no longer deletes a live entry; a failed fork, stop or settings change shows an error; a 200 login page from a proxy no longer counts as a successful send.
- **Dictation** no longer leaves the microphone on when the composer unmounts during the permission prompt, recovers when the microphone is unplugged, and reports denied/missing devices in your language.
- **In-app updates work again for a plain `foxnio` launcher install.** The worker killed the launcher it needed, the launcher was never told to restart, and the restart request had the wrong shape, so the server stayed down while the update showed success. The update now pre-flights the registry before stopping anything, restarts the previous release when the install fails, and uses a plain `node npm-cli.js` call on Windows.
- **Desktop installers**: the Windows installer and portable build no longer share one file name, the workflow uploads installers instead of whole build directories (about 3 GB per run before) with 7 day retention and a write-permission job only for tags, test files are not packaged, the port falls back when 30177 is busy, and in-app self-update is disabled in the desktop app.
- **The Windows tray app uses the foxnio names.** The bundled `bin/omp-web-tray.exe` was still the upstream build: its **Start with Windows** item checked and created `omp-web-tray.lnk`, while the tray installer and uninstaller use `foxnio-tray.lnk`, so the menu showed autostart as off and turning it on added a second startup shortcut that uninstalling left behind. It is rebuilt from the fork's source.
- Smaller fixes: a corrupt usage database is quarantined and rebuilt; restoring an archived session into a removed folder works; a subagent transcript line larger than 256 KiB is no longer dropped; the file viewer keeps updating after a file is replaced by rename; a timed-out utility `omp` process is replaced; the draft store evicts the least recently used draft; the agent routes answer `409`/`504` for transient session errors and `400` for malformed bodies.
- **Scrolling on a phone no longer opens or closes the sidebar and file panel by accident.** A drawer swipe now needs 56px of mostly horizontal travel (at least twice the vertical travel), and a touch that moves more than 36px vertically before then stays a scroll even if it later drifts sideways. The Explorer's inline Mention and Download buttons are 36px on phones, up from 24px, so a tap on a row no longer lands on them. ([upstream #355](https://github.com/kahme247/ompweb/issues/355))
- **Mobile file-panel drags no longer open files or folders by accident.** Explorer rows and local Markdown preview links now swallow the click produced by a scroll or horizontal panel gesture after more than 10px of pointer travel, while deliberate taps and keyboard activation remain unchanged. ([upstream #355](https://github.com/kahme247/ompweb/issues/355))
- **A new chat no longer fails with "Session not found" when its runtime was lost before the first message.** Typing `/` (or any action that starts omp early: `/compact`, `/btw`, `!` shell commands, Fast/Slow toggles, the system prompt panel) creates the runtime for an unsaved chat, which has no session file yet. If that runtime disappeared before the next action (cleaned up while no tab observed it, omp exited, the server restarted), every command for its id answered `session_not_found` because, unlike a saved session, it cannot be resumed from disk. These actions and the first message now check the runtime is still running (skipped while the chat's event stream is open, one shared check for concurrent actions) and start a replacement when it is not. ([upstream #316](https://github.com/kahme247/ompweb/issues/316))
- **A new chat shows the Advisor as On when it is on by default.** The per-chat indicator started Off even when `advisor.enabled: true` was set in omp's `config.yml` or the project's launch settings, although omp was already running the advisor. The default is now read from both sources (`/api/advisor-default`), and a chat's own toggle only adds the advisor to a chat whose default is off: omp has no launch flag that turns a configured advisor off, so a default locks the toggle On and says why. A project launched with `--profile` reads that profile's own `config.yml`, as omp does. Settings → **Agent & Intelligence** has its Advisor section back (enable by default, backlog, review subagents) to change the persistent default. ([upstream #323](https://github.com/kahme247/ompweb/issues/323))
- **The Subagents header reads "N/M complete" once nothing is running.** It used to show the running count, so a finished roster of six read `0/6`. While any subagent runs it still shows the running count; otherwise it shows how many completed, like the Tasks panel (failed and aborted subagents are not counted as complete). ([upstream #352](https://github.com/kahme247/ompweb/issues/352))
- **Session API responses drop fields the UI never reads.** `inputTransformations`, `requestControls`, `contextSnapshot` and thinking-block `thinkingSignature` are no longer sent with a session's messages, which cuts the payload of long sessions by more than half. ([upstream #307](https://github.com/kahme247/ompweb/issues/307))
- **OMP tool access defaults to the CLI's full capability and stays visible.** New browser profiles use `full`; the chat shows the current session's toolset, and workspace profile/extra launch arguments can be inspected and edited from the sidebar menu. Reload reapplies a known preset; if a resumed session's active toolset is unknown, it refuses reload rather than silently changing tool access. ([upstream #356](https://github.com/kahme247/ompweb/issues/356))
- **In-app updates work when ompweb runs as a systemd service.** The update worker ran inside the service's cgroup, so stopping the server killed the worker too: nothing was installed, the service could stay down (`Restart=on-failure` does not restart a clean SIGTERM exit), and every page load reopened the update dialog at "Stop ompweb-managed sessions". The worker now runs in its own transient scope (`systemd-run --scope`) and stops, updates and starts the unit through `systemctl`, starting it again if the install fails.
- **An update whose worker died is reported as failed.** A running update whose worker process is gone, or whose lease has expired, now becomes a failed attempt the dialog can show and clean up, instead of waiting forever.
- **The Provider Usage header stays put while its list scrolls.** Scrolling a long provider list in the sidebar also scrolled the section header (title, window toggle, refresh) out of view, on desktop and mobile. Only the list scrolls now.
- **The Git panel shows changes when the project is opened through a symlink.** Changed files were matched against the repository root with a purely lexical path check, so a cwd that was a directory symlink to the repository dropped every file. Status and diff now canonicalize paths before the containment check, report file paths in the caller's cwd namespace, and still refuse paths that leave the repository through a symlink.

### Known issues

- `nix build` of this release fails while evaluating `nix/package.nix` (`next-env.d.ts ... is a path that does not exist`). It is fixed on the `foxnio` branch after the release.

---

## [v0.6.0] - 2026-10-26

### Added

- **Numeric tables become accessible charts.** A completed assistant reply containing a numeric table also renders it as a chart (bar, line or scatter, chosen from the data) with the original table kept below, and the chart can be exported as SVG. Charts only appear in completed replies, never while streaming.
- **Project MCP servers can be switched on and off from Settings, and a session can be reloaded.** Toggling a server writes the project MCP config and, for an idle session, respawns it so the change takes effect; a running session refuses the reload instead of interrupting work. The config editor also supports the standard omp config locations and server types (stdio, http, sse).
- **Agent-callable server-side tools, off by default.** With the setting enabled, an agent can list sessions, start a new session, and send a message to another session through omp-web's own tools, with per-source rate limits and a chain-depth cap so agents cannot loop through each other.
- **Toggle the provider usage widget between 5H and 7D.** The usage chip cycles Auto → 5H → 7D → Auto, and the choice is remembered in the browser.
- New sessions get a title on their own. omp does not name sessions in RPC mode ([can1357/oh-my-pi#14616](https://github.com/can1357/oh-my-pi/issues/14616)), so they stayed untitled until **Generate title** was clicked. After a reply finishes, omp-web now asks omp's title generator to name an untitled session, the way omp's terminal UI does. omp skips a bare greeting, so a later reply in the same session tries again, up to three times. The request runs in the background: the chat shows no run and none of `/rename`'s output, and a title you set yourself is never replaced.

### Fixes & Improvements

- **Model switches survive a cold start.** Switching models on a session whose omp process had stopped used to fail with HTTP 500, because the resume spawn carried no model and omp exited before the switch RPC ran. The spawn now carries the requested model, and the switch is verified against the session state, falling back to the spawn-bound model when the RPC reports a spurious "Model not found". (#277)
- **The chat minimap tooltip stays aligned while the rail scrolls.** Tooltip rows no longer drift or clip when the minimap is scrolled or dragged; the tooltip position and the drag mapping follow the rail's actual layout. (#251)
- **Usage buckets are labelled correctly.** The Anthropic Fable bucket is labelled as such, and Antigravity's second bucket is shown instead of being hidden. (#284)
- **The Linux tray no longer drags in `dbus-next` at install time.** The dependency is loaded on demand only when the tray runs, removing 99 packages from the install; without it, the tray command exits with an install hint. (#268)
- **Transient composer live status merges into the tasks header row.** The standalone live-status bar is kept only as a fallback, so the composer area stays quieter while the agent works. (#245)
- **Active sessions survive status delays and pending prompts.** A session no longer drops out of the active list while its status is delayed or a prompt is still pending. (#263)
- **Performance work:** usage sync batching, subagent header caching and ANSI panel trimming (#287); streaming git attribute parsing and a faster file-index walk (#286); a fast path for math-free Markdown, cached file-fuzzy metadata and deduplicated session stats (#283); reused edit-distance buffers and a bounded content-search cache (#282).
- **Notification pushes lost to network errors are retried**, and the cause is logged instead of silently dropped. (#280)
- **The composer's primary button follows the Steer setting**, so it offers Steer when steering is the configured behavior during a run. (#281)
- **Many concurrent omp-web tabs work.** The live event stream is multiplexed through one shared worker per browser instead of one SSE connection per stream, so the browser's per-host connection limit no longer freezes tabs. (#257)
- **Transcribe with omp's own speech-to-text models**, including a ChatGPT/Codex subscription, without a separate STT server or API key: set `OMP_WEB_STT_MODEL` and leave `OMP_WEB_STT_ENDPOINT` unset. (#249)
- **Mid-prompt skill autocomplete** in the composer, with skill session auto-naming fixed alongside it. (#260)
- **Same-session message editing — Draft, pending final gates and maintainer CI/review.** Edit moves omp's live history to before the selected message and prefills its text for editing and resending. Ordinary single-owner Edit keeps the session ID/file; native ownership conflicts may legitimately move the conversation to a sibling ID/file. The server follows native persistence notices and registry aliases; the browser adopts the HTTP-confirmed identity without remounting the composer. Old continuations remain historical branches rather than new model context. Edit requires full session settlement, including background deliveries; older runtimes without that signal refuse editing. Installed input hooks must pass the private edit command through unchanged; no new upstream API is required. Correlated results, not bare native acknowledgements, confirm completion; observed persistence errors fail Edit without releasing its fence before handler completion or awaited process teardown. Pending edits preserve drafts, newer typing and attachments, leave recording controls usable, and ignore delayed edit echoes that would reset a newer view or turn. Identity moves transfer exact-source drafts without consuming another cache slot; text survives full reload through sessionStorage, while attachments remain memory-only. Pending transcription retains its original job/scope and a tab-local move association; ambiguous unacknowledged uploads remain recoverable rather than being guessed or reuploaded. Rejected sends restore outgoing content to the originating conversation, following new-session promotion without touching another chat; superseded failures do not reinsert processed turns. Renaming, including automatic-title fallbacks, respects the edit lock. Connection replacement/unmount owns readiness cancellation and StrictMode-safe cleanup. Isolated native checks cover relocation, observed write errors and reopening; separate actual AppShell checks use controlled HTTP and are not production native/browser end-to-end proof. Fork and read-only historical browsing remain separate; Edit does not undo filesystem/tool side effects, restore original-message images or promise stronger fsync durability. (#276)
- Fix test fixtures on macOS and paths containing spaces: report the actual tray platform, launch the transcription gateway stub with the exact quoted Node executable, and separate deterministic known-path cache invalidation from native filesystem-watch delivery without weakening authorization or content assertions.
- Fold tool activity while the agent works, the same way a finished turn folds it: the transcript shows one **Process details** row per turn instead of a row per tool call, and expanding it shows every call as it streamed. Assistant replies keep streaming in view, and the composer keeps naming the running tool. Turn off **Hide tool activity while working** in Settings → Interface & Behavior for the previous row-per-call view.
- **On desktop, notifications open from a bell in the top bar**, left of the right-panel toggle. The bell shows the unread count and opens a floating panel with the notification history, **Mark all as read** and **Clear**; the list scrolls inside a panel of limited width and height. Opening a notification closes the panel, and closing it marks the shown notifications as read. The right panel's Notifications tab and the right-panel toggle's unread count remain on phones only.
- On phones and narrow windows, the top bar's tools menu is only as wide as its buttons instead of spanning the screen, and its **System** button opens the system prompt again. The prompt panel used to open inside the menu's sideways-scrolling strip, which clipped it out of view.
- **Search looks inside sessions and ranks by relevance.** The workspace search now also matches the text of your messages and the assistant's replies, not only titles. Each word is matched on its own, in any order and with small typos tolerated; results matching your word order, and matches in titles, rank first. Put text in "quotes" to require that exact phrase. Title matches show at once; transcript matches stream in while a spinner shows the search is running, and **Stop** ends it, keeping the results found so far.

### Sidebar

- **Recently completed sessions stay in the running filter.** A session that just finished no longer vanishes from the running filter at once; it remains visible as recently completed. (#267)
- **Sort and pin workspaces.** A sort button next to the workspace search switches between None (your manual order), Alphabetical and Last updated (the workspace whose session got the newest message first). While a sort is active, each workspace has a pin button: pinned workspaces stay at the top in the order you give them with Move up, Move down or dragging, and newly pinned ones join the end of that group. Unpinned workspaces follow the sort and cannot be moved by hand. The sort is remembered per browser; pins are stored with the workspace list. (#271)

---

## [v0.5.2] - 2026-10-15

### Breaking changes

- **omp-web now requires Node.js 24 or newer** (the current LTS). `ompweb` and its service and tray commands (`ompweb-systemd`, `ompweb-launchd`, `ompweb-tray`, `ompweb-tray-linux`) refuse older versions before doing anything.
- **A plaintext web password no longer reaches the server.** `ompweb --password` now stops the launcher at startup, and the server refuses every request while a plaintext password is in its environment. Every `omp` session inherits omp-web's environment, so an agent running `env` could print the password into its session file and send it to the model provider. Replace it with `OMP_WEB_PASSWORD_HASH`: run `ompweb hash-password` (it reads the password from stdin, so it stays out of shell history and `ps`) and pass the printed `scrypt$…` value. As a migration step, `ompweb` still accepts `OMP_WEB_PASSWORD`: it hashes the password at startup, keeps it out of the server's environment, and logs a warning with the hash to set as `OMP_WEB_PASSWORD_HASH`. Switch soon: agents can still read the plaintext from the `ompweb` launcher process, and each start makes a new hash, so every restart signs all browsers out. Setting both variables stops the launcher. The service installers hash an `OMP_WEB_PASSWORD` given at install time, so `OMP_WEB_PASSWORD='…' ompweb-systemd install` still works and now stores only the hash; the Linux tray's **Set Web Password…** does the same. Existing session cookies are invalidated.

### Added

- **The Notifications tab keeps its list across reloads, restarts and devices.** omp-web now records the notifications you turned on (task finished, waiting for input, run failed, model switched) on the server, including ones sent while no tab was open, and every browser shows the same list and read state. A notification for the session you are looking at is listed as already read. Entries appear in the language of the browser showing them. Notification settings, push subscriptions and keys move into a SQLite store in omp-web's data directory, using the SQLite module built into Node.js 24; the first start imports them from the old `notifications.json`, so existing push subscriptions keep working.
- Transcribe voice input with a model omp already has credentials for, such as your ChatGPT subscription: leave `OMP_WEB_STT_ENDPOINT` unset and set `OMP_WEB_STT_MODEL` to an omp speech-to-text model, for example `openai-codex/codex-transcribe`. omp-web runs it through `omp auth-gateway stdio`, so no API key or separate STT server is needed. Recordings are limited to 18MB on this path. Requires an omp release with that model ([can1357/oh-my-pi#15391](https://github.com/can1357/oh-my-pi/pull/15391)).
- **Expand thinking blocks by default**, an off-by-default switch next to **Keep tool calls collapsed** in Settings → Interface & Behavior. Turn it on to read the model's reasoning without expanding every block; each block still collapses and expands by hand, and the choice applies to a block that is still streaming as well. Tool-call collapsing is unchanged.
- List every account omp stores for a subscription provider in Settings → API Keys & Providers and disconnect a single account with its **Disconnect** button; the other accounts stay connected and omp keeps choosing and rotating between them. The sign-in button of a connected provider now reads **Add account**: signing in with another account adds it, and signing in with a connected account refreshes it. Requires omp 18.7.0 or later ([can1357/oh-my-pi#14588](https://github.com/can1357/oh-my-pi/pull/14588)); older omp keeps the read-only account list from `omp usage` and explains how to disconnect from a terminal.
- Add **Settings → Notifications**: desktop and mobile notifications for a finished task (after the prompt and any background work it started are done; subagents never notify), a question or approval waiting for you, a run that failed after retries and fallbacks, and a model switch omp made on its own (for example Fable falling back to Opus after a refusal, or a usage-limit fallback). Each browser chooses its own events and whether to show an in-app toast or a system notification while you use omp-web in another tab. Nothing is shown for the session you are viewing, and clicking a notification opens its session; an in-app toast opens it from a click or tap anywhere on it, or Enter when it has keyboard focus. Over HTTPS (or on `localhost`) notifications arrive through Web Push even with no omp-web tab open, including the iPhone/iPad app added to the Home Screen; the push keys and device list live in `~/.omp/agent/omp-web/notifications.json`. Notifications are off until you turn them on. This replaces the previous completion notification for the open session, and the agent's `notify` tool now also works on Android.
- Skip the web password for clients your reverse proxy trusts: the proxy sends a secret in `X-Omp-Web-Auth` only for trusted address ranges, and omp-web holds only the secret's SHA-256 digest in `OMP_WEB_TRUSTED_HEADER_SHA256`. Other clients still sign in with the password. The README shows how to generate the secret without it reaching shell history, and an nginx setup, including how to trust the real client address behind Cloudflare, Cloudflare Tunnel or another proxy, and how to guard against DNS rebinding. The service installers preserve the setting, and the digest never reaches child processes.
- Choose **Classifier** or **Vendor default** in Settings → AI Model Defaults → **Auto Thinking Source** when Reasoning is `auto`. The choice is saved in omp's native config for newly started or restarted agents. Vendor mode prefers the publisher's effort, then omp's per-model default, then normal Auto fallback. Requires an omp release containing [can1357/oh-my-pi#14114](https://github.com/can1357/oh-my-pi/pull/14114).
- Show conflicting skill names and deduplicated installations when an OMP session starts, with resolution details, a **×** button that dismisses the notice for the session until the diagnostic report changes, and a persisted **Turn off** action that disables startup notices. Inspect a running session manually in **Settings → Extensions & Tools → Skills**, even when notices are off; inspection never resumes a stopped session. Requires an OMP runtime with the skill-diagnostics RPC commands; older runtimes report live diagnostics as unavailable.
- Ask a side question with `/btw <question>`: omp answers from the current conversation in a panel above the composer, even while the agent is working, and the question never enters the chat. Cancel a running answer, copy it, or ask follow-ups in the same topic. `/btw` on its own lists the session's past side questions, including ones asked in the terminal, each expandable to all its turns with **Copy** and **Follow up**. Side questions are text-only: with an attachment in the composer, `/btw` is refused and the draft is kept. An answer that omp lost (for example after its process restarted) shows as **Interrupted** instead of spinning. Requires an omp with the `btw` RPC commands; older omp shows "/btw requires a newer omp" instead of sending the text to the model.
- Show omp's Claude usage-limit badge in the composer toolbar, matching the terminal status line during the wrap-up allowance or once `/slow` low priority takes over. Reset times use the browser's locale and timezone. Requires an omp version whose `get_state` reports structured `usageLimit` state.
- Add a **Slow** toggle next to **Fast** in the composer toolbar, the equivalent of omp's `/slow`. On Claude models it turns low priority on or off in your omp settings, so it applies to every session and terminal; on OpenAI and Google models it switches this session to the provider's flex tier. Once the session's omp process runs, the toggle follows omp's `get_state` (`slowModeSupported`); before that, including in a new session, it follows the selected model's provider (`anthropic`, `openai`, `openai-codex`, `google`, `google-vertex`) and, on Claude, the `providers.anthropic.slowMode` setting. Clicking it there starts the session's omp process.
- Show the composer's reasoning level with TUI-style icons, alongside its name on desktop and without the name on narrow toolbars. The menu pairs each icon with its level name. Icons use consistent, vertically centered shapes rather than font-dependent Unicode glyphs, with larger mobile controls, smaller desktop controls, and support for high-contrast colors. Keep the model icon visible on phones and reduce unused space between the model and reasoning controls without wrapping the standard toolbar controls. Provider-defined levels retain their names with normal truncation.
- Keep the reasoning menu in one column on phones as well as desktop, with one full-width level per row instead of side-by-side chips.
- Add **Paste image** to the composer's **+** menu, with Japanese and Simplified Chinese translations. Requires HTTPS (or localhost), browser support for clipboard image reads, and clipboard permission; the item is hidden where the browser cannot read images from the clipboard. Attaching a file remains available.
- Name web app installations, iOS home-screen titles, and browser tabs after the server's hostname (without port), so multiple servers can be told apart. Localhost and IP addresses keep the generic `omp web` name; named LAN hosts are preserved. Tabs show `workspace - installation name`. Existing installations may need to be re-added to pick up the new name.
- Name web app installations, iOS home-screen titles and browser tabs with `OMP_WEB_NAME`, so multiple servers can be told apart. Unset or blank keeps `omp web`; `url`, `host` or `domain` (any case) uses the hostname the browser connected to, without port, keeping `omp web` for localhost and IP addresses; any other value is used as-is. The service installers preserve the setting. Tabs show `workspace - name`. Existing installations may need to be re-added to pick up a new name.
- Create a workspace by cloning a Git repository: in the **Add workspace** dialog, enter an `https://` or ssh URL and choose **Clone here** to clone into a new folder under the selected directory, which then becomes the active workspace. Clone progress streams into the dialog; **Cancel clone** stops git and deletes the partial clone. git never prompts, so private repositories need a credential helper or ssh agent.
- Add a manual refresh button to the sidebar's Provider Usage panel, with the same success feedback as workspace refresh. Manual refresh bypasses omp-web's usage cache and invalidates omp's cached reports before fetching fresh limits; automatic five-minute refresh remains unchanged. Manual refresh requires an omp that supports `usage invalidate`; an unsupported or failed refresh shows as unavailable instead of reporting success.
- Add an off-by-default **Resume running sessions after a restart** setting in Settings → System & Updates. When omp-web restarts while agents are working, it restarts those sessions and prompts each with "Session interrupted and resumed. Continue as you would have done without the interruption." Work in progress at the moment of the restart, such as a running command, is lost. Do not also resume those sessions from a terminal while omp-web is down.
- Add **Copy** and **Markdown** below user messages and completed assistant replies, with keyboard access and touch-sized controls. Copy only message text, excluding thinking, tool output, and renderer controls; preserve full source for oversized raw-text messages. Shorten message actions to **Fork** and **Read** to leave more room on mobile; the speech tooltip and accessible label remain **Read aloud**.
- Scope Ctrl+A / Cmd+A to the selected message, currently loaded chat, or active file contents instead of the whole page. Message selection includes collapsed extension previews and expanded details without toolbar labels. Newer pane focus takes precedence over retained child selections. Text fields and IME composition retain native behavior; browser-menu commands and embedded viewers remain browser-controlled.
- Add an off-by-default **Scope native Select All (experimental)** switch in Settings → Interface & Behavior. The per-browser preference narrows whole-page selections from native menus while leaving keyboard scoping independent. Disable it if browser selection handles or menus behave unexpectedly; intentional whole-page selections can also be narrowed.
- Add a **Notifications** tab, first in the right panel before Explorer and Git, listing the last 100 toasts and system notifications (task completions, agent `notify` messages). Entries keep their action buttons and can be dismissed one by one or all at once. While notifications are unread, the panel toggle shows their count and opens straight to the tab; entries become read when you leave it or choose **Mark all as read**. Toasts now stay on screen for 6 seconds, and errors for 10 seconds. On touch screens, swipe a toast or a Notifications entry left or right to dismiss it, as on Android; the swipe can start anywhere on it except its buttons, and it never also moves a sidebar. Changed your mind mid-swipe? Drag it back toward the centre before letting go and it stays. A mostly vertical drag still scrolls the list. A mouse drag now selects text instead of dismissing a toast, and toasts no longer dismiss with a downward swipe. The mobile sidebar swipes also keep working while a toast is on screen.
- Play back a voice recording before transcribing or sending it. Pause keeps a left-side preview control; Stop opens a review deck with play, discard, and transcribe-and-send.
- Link GitHub issue and pull-request references in chat messages. Bare `#123` links to the session checkout's GitHub repository (the `gh` default remote, else `upstream`, `github`, then `origin`); `owner/repo#123` links to that repository. Code spans and existing links are left unchanged.
- Show all of an agent's ask-tool questions in one panel, with checkboxes for multi-select, radio buttons for single-select (recommended option marked and preselected), and an **Other** option per question whose text box is the option itself, submitted together. Typing in it chooses **Other**; choosing another option keeps the text in place, and choosing **Other** again uses it. While the questions are open the message box is hidden, so it is clear the answer goes in the panel; **Cancel** brings the message box back with your draft untouched. Requires an omp that supports `set_ask_dialog`; older omp keeps the one-question-at-a-time dialog.
- Make `agent://<id>` subagent handles in chat messages clickable. Bare handles, inline code containing only a handle, and Markdown links open that subagent's result dialog; `agent://Parent/Child` opens the nested `Parent.Child` subagent when the roster knows it. A `read` of an `agent://` handle opens the same dialog from its tool row.
- Show the full model name, including its provider (for example `anthropic/claude-sonnet-5-5`), and the reasoning effort in the subagent result dialog, for running subagents and for finished ones after a reload. Finished background subagents take them from their saved transcript, so they also appear in the composer's subagent chips.
- Attach images and text files while the agent is running, and send them with a steer or a queued follow-up. Attaching through **+**, paste, or drag and drop now works during a run; with only attachments in the composer, **Stop** becomes **Queue**. An image-only message shows as `[Image]` in the queue. A steer or follow-up that omp refuses returns to the composer with its images, and so does a queued message taken back by **Edit** or **Stop**. Getting images back from **Edit** and **Stop** requires an omp with `abort_and_restore_queue` and image-returning `remove_queued_message` ([can1357/oh-my-pi#14179](https://github.com/can1357/oh-my-pi/pull/14179)); older omp returns only the text.
- Open file paths that chat messages write as inline code in the file panel, so a screenshot path such as `` `/var/tmp/shot.webp` `` shows in the image viewer. Absolute paths with at least two segments, `~/` home paths, Windows drive paths, and workspace-relative paths with a directory and file extension link; a `:line[:col]` suffix is dropped when opening. Other code, scheme handles (`history://`, `agent://`, `https://`) and fenced code blocks stay unchanged. Files outside the workspace open when the session mentions them, now including `~/` mentions; bare paths in prose are not linked.
- Show omp's passive tool context as one dim `↳ Context: …` line on the last tool card of the tool batch it follows, matching omp's terminal, instead of a separate developer-message row. Hover the line for the full text; expanding the card shows the full text as its own section below the output. ANSI codes and control characters are removed and the text is collapsed to one line. Context that follows a non-tool message is not shown, so it never lands on an earlier, unrelated card. In a batch of several tool calls the line sits on the last call's tool row. Copy as Markdown and transcript exports leave it out. Requires an omp release containing [can1357/oh-my-pi#13269](https://github.com/can1357/oh-my-pi/pull/13269); with older omp, passive context still shows as a developer-message row.

### Fixes & Improvements

- On a phone, the first tap on an option, **Submit** or **Cancel** in a question panel now acts on it. It used to only close the keyboard or resize the panel, which moved the target out from under the tap. The message box's keyboard now closes as soon as the question appears (the message box is hidden then anyway), the panel no longer resizes when an option or button takes focus, and while you type in **Other** a touch or pen tap elsewhere in the panel no longer moves focus first. Choosing an option then closes the keyboard; tapping back into the kept **Other** text chooses it again. **Submit** closes the keyboard at once instead of after the server confirms the answer, and collapsing the keyboard while typing in **Other** no longer makes the next tap raise it again for a moment. A mouse, including one on a touchscreen laptop, keeps its usual behavior.
- On a phone, opening the keyboard at the end of a conversation no longer hides the newest messages under it: the chat stays scrolled to the bottom. The same holds when the message box or a question panel grows. A conversation you scrolled up in stays where it is.
- When the agent finishes a reply, the chat no longer jumps up to the start of the reply and back down. The finished reply used to disappear for a moment until its saved copy was loaded; it now stays on screen and the saved copy replaces it in place.
- **Passive tool context shows its wrapper.** Context wrapped in a tag such as `<system-reminder source="graphify">` now names the tag and every attribute on the tool card's `↳ Context (system-reminder · source=graphify): …` line. Expanding the card shows the context as a small nested card with that header and the body below, like developer reminders. Before, the tag name and attribute keys were dropped, so a graphify nudge looked like unlabelled text.
- `ompweb hash-password` in a terminal finishes when you press Enter. The hidden prompt waited for a newline, but a terminal in raw mode sends Enter as a carriage return, so the prompt never ended.
- The Notifications tab now tells unread notifications from read ones: an unread notification has an accent dot before it and a bold title on a tinted row, and read notifications are dimmed. The tab also lists only the notifications that can also be pushed (task finished, input needed, error, model switch). Confirmations such as "Saved", copy results, update notices and agent `notify` calls still show as toasts but no longer fill the tab. A session's next notification of the same type is unread again instead of inheriting the earlier one's read state.
- Fit the agent's question panel on a phone. A long question, header or option preview no longer widens the panel past the screen and clips the answer text at the right edge, and previews wrap instead of scrolling sideways.
- A question that arrives while you are composing on a touch device no longer pulls focus into its answer box, which raised the on-screen keyboard and scrolled the unread question away. The panel waits for a tap; on a desktop with a keyboard it focuses its first field as before.
- Reach **Submit** with the keyboard open: the question panel is now capped to the visible area so its Cancel/Submit footer stays on screen, and the dialog's buttons follow the **Touch Targets** setting.
- Submitting a message while the agent is working now queues it by default instead of steering, in Settings → Interface & Behavior → **Message during active run**: steering a long tool or shell command could abort the turn mid-task and left the new message undelivered. A previously saved choice is kept; only an empty setting changes meaning. Sending during omp-web's own `!!` shell command no longer fails with "Cannot send a prompt while a shell command is running": the message is handed to omp's queue instead of aborting anything, the optimistic bubble is withdrawn, and a notice says it was queued behind the running command.
- Keep omp-web's own secrets out of every child process it starts, not only the `omp` session processes: plugin install and upgrade, skill install/update/search, update checks and the self-update worker, agent unpack, and the Git commands the file panel runs. A session environment no longer contains the web password hash, so `env` inside an agent no longer prints anything that grants access to this server. `OMP_WEB_*` values that are configuration rather than secrets (the `omp` binary path, port, package dir) keep reaching the processes that need them.
- Sign web sessions with a per-installation random key (created on first start at `~/.omp/agent/omp-web/web-auth-secret.json`, mode `0600`) mixed with the password hash, instead of the hash itself. Anyone who reads the hash out of a service environment file can no longer forge a session cookie, and changing the password still signs every browser out.
- On Windows, changing or removing the web password hash with `setx` now takes effect at the next server restart. The tray (native and PowerShell) and the background service read `OMP_WEB_PASSWORD_HASH` from the user, then system, environment each time they start the server, instead of preferring the copy they captured at logon, so an old password no longer keeps working after you rotate it. The native tray previously did not pass the hash on at all.
- The **Notifications** tab now lists notifications that appeared as system notifications too, not only in-app toasts, including Web Push notifications that arrive while an omp-web tab is open. Click or tap an entry for a session, or press Enter on it, to open that session; its dismiss button still only removes it. The list is still kept per tab in memory, so pushes that arrive with no omp-web tab open are not listed.
- Opening a notification by clicking or tapping its toast now marks it as read in the Notifications tab, so it no longer counts toward the unread badge. A later notification of the same kind for the same session is unread again, even after the earlier one was read.
- Word-completion ghost text in a scrolled composer now appears right after the caret. When the draft had text after the caret, it used to be drawn lines further down.
- Show a single plus sign on the **Add provider** buttons in Models settings, and none in the Add provider dialog title. The translated label no longer repeats the button's **+** icon.
- Links in a Markdown file preview no longer navigate omp-web away. A relative link the file panel cannot open, such as one in a Markdown file outside the workspace, shows as plain text with its target on hover; web links open in a new tab. An image the panel cannot load shows its alt text instead of a broken image.
- The image viewer now opens with the whole image fitted to the screen on every device, instead of at 100%; images smaller than the screen stay at their real size. The zoom percentage is always relative to the image's real pixels, at every Interface Scale. Zoom out goes down to 10%, or further to the fitted size for very large images, in ×1.25 steps. **Fit to screen** and **1:1** (actual size) replace **Reset zoom**. Zooming keeps the centre of the view in place, and a zoomed-in image can now be scrolled to every edge; before, the parts outside the starting size were cut off. The viewer covers exactly the window at Compact, Comfortable and Large Interface Scale, and its buttons follow the **Touch Targets** setting, wrapping on narrow screens instead of being clipped.
- Show images from tool results again after reopening or reloading a session. Since tool-result images were dropped from the initial history load, screenshots and image reads showed only `[1 tool result image omitted from initial history payload …]`, with a wrong byte count. Expanding the tool row now shows a small preview; click it for the full image. Previews are 480px WebP files generated once and kept in omp-web's data folder, and live tool output also arrives as a link instead of inline base64, so many large screenshots no longer slow the chat down or fill browser memory.
- The completion notification omp-web used to show for the open session when its tab was in the background is gone, along with its permission prompt on the first finished run. Turn on **Settings → Notifications** to get notifications again; they now cover every session, not only the open one.
- Builds no longer fail at random while fetching fonts. Google Fonts sometimes serves Noto Serif SC through links Next.js cannot parse, so omp-web now ships its own copy: a 2.2 MB subset (weights 600–700; GB2312, kana and CJK punctuation), downloaded only when a page shows Chinese or Japanese text in a heading. Characters outside the subset use the system's CJK serif font. The Nix package's local-font patch applies again.
- Balance the composer icons on phones and narrow toolbars with a slightly smaller effort-level icon and a larger Slow-mode snail, while keeping menu icon sizes unchanged.
- Keep the model picker on the left and reasoning effort, Fast, Slow, microphone, and Send/Stop controls in a right-aligned composer group, including wrapped mobile rows.
- The Provider Usage panel now shows each account's email instead of omp's redacted form (`an*`); accounts without an email show as **Account N**. Only the email, plan and limits reach the browser.
- The composer's reasoning menu now uses the same borderless rows as the model picker instead of bordered cards.
- The context popover now uses the room above the composer instead of a fixed 380px cap, so it only scrolls when the window is too short for it.
- Fix settings crashes, stalled session catch-up, and failed voice transcription polling in browsers without `AbortSignal.timeout`, `AbortSignal.any`, or `Promise.withResolvers`, including development-mode clients. Client requests now use `AbortController` timers and ordinary promises while retaining timeouts and cancellation (#196).
- Allow development requests from all RFC1918 private IPv4 ranges, not just `192.168.*.*`. Set `OMP_WEB_DEV_ORIGIN` to allow a tunnel or reverse-proxy hostname without editing `next.config.ts`; the setting is development-only.
- Fix authenticated app-installation metadata: serve `/api/manifest` through the existing password guard with one credentialed manifest link and embedded packaged PNG icons, avoiding cookie-free native installer icon downloads. Preserve the app identity and root launch URL/scope, retain private revalidating caching, and remove the obsolete public-manifest exception. Verified in local Chromium with HTTP icon URLs blocked and no installability errors; the owner also confirmed successful installation on a physical phone behind Cloudflare Access.
- Manage Git worktrees from a new **Worktrees** tab in the file panel, next to Explorer and Git. It lists the active workspace's worktrees and switches, creates, and removes them; removing one with uncommitted changes asks before forcing. The new-session screen also gets a worktree picker under **Workspace** when the selected workspace has more than one worktree. Switching in either place moves the folder where new sessions start and leaves the open session alone. While a session is open, Explorer, Git, and open files show that session's folder. The workspace list no longer shows a branch selector beside each workspace name.
- Keep the sidebar's action menus inside the screen on phones and at larger interface scales.
- The **Agent environment variables** editor in Settings → System & Updates now sits below its title and description and follows the page width, instead of sitting beside them and extending past the right edge. The text box also grows with its contents.
- Show queued steers and follow-ups on every device viewing a session. The queue panel now shows omp's own queue (omp 18.4.4 or later) instead of a copy kept by the tab that sent them, so it also stays correct across reloads.
- **Stop** no longer loses a queued steer or lets the agent run it anyway: as with Esc in omp's terminal, every message still waiting in the queue moves back into the composer. With omp's `abort_and_restore_queue` (newer omp), omp takes the queue back and aborts in one step, which also covers a steer you just promoted that this page's queue had not caught up with, and one the model already picked up through live steering (for example OpenAI models with `providers.openaiLiveSteering`). If that request fails, Stop retries it once and warns when the messages may not have come back. Older omp (18.4.4 or later) falls back to removing each message the page lists before the abort; there, a steer the page does not list or the model already took still runs after Stop, and attached images are dropped.
- Long voice transcriptions no longer fail with `Unexpected token '<', "<!DOCTYPE "... is not valid JSON` behind a reverse proxy. The server now keeps the recording and transcribes it as a background job (up to about 5 minutes) while the browser polls short requests, so proxy timeouts no longer cut off a slow STT endpoint. The job survives the recording browser disconnecting: any browser showing the same session picks it up, can play the recording and retry a failure, and the transcript is inserted in exactly one browser. A **Transcribe and send** (or queue) choice stays with the job, so the transcript is still sent after you switch sessions and come back; if the agent is running by then it is queued as a follow-up, and a queue choice whose run has ended is sent. Another browser that finishes the job only inserts the text. **Transcribe and send** from the review deck now sends too. Recordings stay on the server (in memory) for up to an hour or until inserted or discarded. Anyone who can reach the omp-web API can list, play and retry those recordings by session, so set `OMP_WEB_PASSWORD` when omp-web is reachable by others.
- Sending a message to a live session no longer fails with **HTTP 404** when the session's transcript cannot be read. An empty baseline is used instead, so the prompt is still delivered. The previous behavior is what surfaced as `Failed to send message: HTTP 404` on sessions created by slash commands.
- The Skills page lists exactly what omp resolves, through `omp skill list --json` (omp 18.3.3 or later): plugin, custom-directory and registry skills appear, and colliding names show as `namespace/name`. Skills that live outside omp-web's skill folders, such as plugin installs, show a disabled toggle because an update would undo the edit. Older omp binaries keep the built-in scan.
- On phones, the top bar's **⋯** menu no longer repeats the session name already shown in the title, and its theme and language pickers open fully instead of being cut off at the bar's edge.
- **Resume running sessions after a restart** no longer resumes sessions that another running omp-web instance (for example a dev server sharing the same agent directory) is still running. Previously the second instance started duplicate agents that ran alongside the originals and wrote to the same session files.
- On phones and tablets, the first time the file panel opens it now takes keyboard focus, closes with Escape, and keeps Tab inside the panel, like every later open. Previously the first open left focus on the toggle button and ignored Escape. Closing the panel after that first open also returns focus to what opened it, such as a file link in the chat, instead of the page body.
- The Git side panel now honors `.gitattributes`: changed files marked `linguist-generated`, `linguist-vendored`, `linguist-documentation`, or `-diff` move into a collapsed "files marked in .gitattributes" group below the main list, and the panel previews the first unmarked change. `-diff` files show that their diff is suppressed, including untracked ones, instead of a generic "Diff unavailable". Files with the `binary` attribute stay in the main list.
- Stop showing tool paths such as `history://…`, `proc://…` and `local://…` as file links. They are resolved by omp, and clicking them opened an "Access denied" viewer tab. `http://` and `https://` paths passed to `read` now open the URL in a new browser tab instead.
- omp-web no longer exits when a browser disconnects in the middle of a POST request, for example when a tab closes while a request is still in flight. A Next.js bug (vercel/next.js#99278) could turn that disconnect into an uncaught `Error: aborted`, which the crash handler treated as fatal. These disconnects are now logged to `diagnostics.log` as `client-abort` and the server keeps running; every other uncaught error still exits.
- When `PI_CODING_AGENT_DIR` points away from `~/.omp/agent`, the crash journal (`diagnostics.log`) is written to `<agent dir>/omp-web/` instead of `~/.omp/omp-web/`, so isolated test and development servers no longer write to the real journal.
- Slide the file panel in from the right edge on phones, with the same timing as the left sidebar, instead of popping it open full-screen. The first open slides too, without a **Loading…** placeholder or a dimmed backdrop flashing over the chat. The panel still covers the whole screen once open, and it opens and closes instantly when reduced motion is enabled.
- On mobile, move the session information control (context ring with stats, tokens, cost, and **Compact context**) to the top-right of the top bar; desktop keeps it in the composer toolbar. Preserve the ring usage coloring, its popover, and the `/session` shortcut. Opening the panel moves focus into it; Escape dismisses it before run shortcuts and returns focus to its opener when focus is still within the panel.
- Make the mobile workspace sidebar full-screen without a dimmed backdrop, with a visible top-left close button. Place the file-panel opener inside the upper bar and add a separate top-right close button inside the file panel, with keyboard focus returning to its opener. Keep the session-title pill centered between the header controls.
- Continue the mobile file-panel tab-row border underneath its close-button cell, so the divider spans the full width.
- On mobile, swipe anywhere on the app surface: swipe right to open the left sidebar or close the right one, and swipe left for the opposite action. No device-edge start or perfectly straight movement is required. Recognition follows overall dominant-axis displacement and tolerates curved thumb movement, a brief corrective start, and shorter deliberate drags. Taps, predominantly vertical movement, multi-touch, text editing or selection, native horizontal scrolling, and open popups retain their normal behavior; persistent drawer lists, including Git changes, remain swipeable. Embedded previews retain native input and full width; swipe on their surrounding toolbar to close the sidebar.
- Let the centered session-title pill fit its content and grow for longer names up to the available header space, instead of stretching short names into a fixed-size box.
- Keep **Collapse input** available after expanding a long user message with **Show full input**, so the message can be collapsed again.
- Agent host tools (`open_url`, `notify`, `open_file`) no longer fail when you switch to another session mid-run. Any open omp-web tab now answers them, and a URL or file from a session you are not viewing opens only after you confirm it in a dialog.
- Ask before opening links from the agent. Turn on **Open agent links without asking** in Settings → Interface & Behavior to open links from the session you are viewing right away; links from other sessions always ask.
- An attached ask panel no longer steals focus after it opens. Typing in a question's **Other** box no longer selects the first option when the text begins with a space, and focus is never pulled back to a radio button once you have moved on.
- Keep every assistant reply visible in the chat. **Process details** now folds only the activity between replies (thinking, tool calls, notices), so a reply that ended a turn is no longer hidden when a background job or reminder resumes the agent.
- Honor omp's **Hide Thinking Blocks** setting in the chat, and rename the toggle from **Thinking Blocks** so its label matches what it does.
- Start system reminders, async job results, and late LSP diagnostics collapsed to their first line. Click the header to expand; reminder headers show their attributes, such as `reason` and `rule`.
- Render Nerd Font icons that omp sends when its symbol preset is set to Nerd (for example the multi-select **Done selecting** check mark) instead of empty boxes. The bundled symbols font (Nerd Fonts Symbols Only, SIL OFL 1.1, about 1.2 MB) applies only to Private Use Area codepoints and is downloaded only when a page shows one of these icons.
- Show late LSP diagnostic notices with their original line breaks, like async results, instead of collapsing them onto one line.
- Unexpected omp process exits now remain visible in the workspace and session sidebar until that session starts again, including the exit code or signal and the last stderr line.
- Show free-text answers to agent questions (the ask tool's "Other" option and other `promptStyle` editor requests) in the chat font instead of the monospace code font.
- Keep line breaks in agent dialog titles instead of running multi-line titles together on one line.
- Restore the Settings toggle track, which the 44px hit area had squeezed into a dot. Cap Settings dropdowns at half the card width with an ellipsis for long options, and stack them below their label at full card width on narrow screens.
- Give the top-bar theme picker the same padding and icon spacing as the language picker; its icon and arrow were squeezed into a 28px button.
- Improve phone and tablet ergonomics with safe-area-aware top chrome, a focus-trapped mobile workspace drawer, an actionable first-run workspace state, touch-sized sidebar actions, narrow-screen composer wrapping, clearer settings loading/retry states, and quieter streaming announcements.
- Keep the Extensions & Tools settings panel scrollable on desktop and touch layouts, including long MCP server lists.
- Let non-native settings tabs render while the common OMP configuration loads, and show static MCP configuration before live status resolution.
- Give the new-session workspace picker a calmer destination card with a folder badge, stronger focus and hover states, a compact path context line, and touch-friendly spacing while retaining the native accessible select behavior.
- Defer the file panel and its Explorer/Git work until first use, use a fixed overlay for the file panel on tablet widths, increase mobile Explorer row height, enlarge Git touch targets, and keep compact session context available in the mobile overflow menu.
- Move focus into attached extension requests, contain keyboard focus in the custom extension terminal, and add a local retry action when a text file cannot be loaded.
- Add local retry actions and status semantics to Explorer, Git, and text-file failure states so transient workspace errors are recoverable without hunting for a toolbar refresh control.
- Defer Explorer and Git tab work until each tab is first opened, avoiding duplicate status requests and hidden-panel overhead while preserving visited tab state.
- Pause content fetches and file-watch connections for inactive file tabs, then resume them when the tab becomes active to reduce background network and rendering work.
- Defer the command-palette chunk until the first Ctrl/Cmd+K shortcut, reducing initial shell work while preserving the existing keyboard workflow.
- Add a visible command-palette action in the topbar overflow menu with the Ctrl/Cmd+K shortcut exposed to assistive technology, while keeping the palette chunk lazy.
- Replace the generic file-panel loading label with a shape-matched skeleton toolbar and rows, giving desktop and mobile users a stable visual handoff while the deferred panel chunk loads.
- Enlarge mobile file-search controls and add inline refresh actions to sidebar load failures, keeping the primary navigation recoverable without relying on the header icon.
- Keep the full-page Settings header clear of notches and home indicators, and enlarge its search, back, and close controls for touch devices.
- Add a localized **Return to latest message** control that appears when a long conversation is scrolled away from the bottom, with reduced-motion-aware scrolling and touch-sized mobile controls.
- Replace the sidebar’s generic loading label with shape-matched workspace/session skeleton rows for a calmer first paint on desktop and mobile.
- Clarify the mobile file-panel control by switching from a panel icon to an explicit close icon when the panel is open, while retaining the existing accessible toggle labels.
- Enlarge mobile session-search and composer attachment-remove controls so common mobile cleanup actions meet the same touch-target standard as navigation.
- Make the compact mobile topbar overflow horizontally navigable so the new command action, session context, and existing controls remain reachable instead of overlapping at narrow widths.
- Localize the command palette’s session-loading state instead of leaving English-only copy visible in Chinese and Japanese.
- Localize the workspace login title, password prompt, unlock action, and authentication errors for English, Chinese, and Japanese users.
- Localize composer attachment limits, skipped-file explanations, read failures, and running-agent attachment errors for English, Chinese, and Japanese users.
- Localize composer retry-abort and attachment removal labels so mobile cleanup and recovery actions match the active interface language.
- Close the mobile topbar overflow when launching the command palette from its visible trigger, preventing the menu from remaining open behind the modal.
- Add localized retry actions to image, audio, and document viewer failures so transient file-loading problems can recover without closing the file panel.
- Keep the login card clear of device safe areas, enlarge password and unlock controls for touch use, and retain the shared focus-ring treatment.
- Add localized inline retry recovery to workspace directory-picker failures, so mobile users can recover without closing the picker.
- Enlarge directory-picker profile, launch toggle, and extra-argument controls on touch devices for reliable workspace setup on phones.
- Enlarge mobile Settings navigation tabs and provider segmented controls to 44px targets, keeping the horizontal Settings header easy to traverse on phones.
- Localize the document viewer’s PDF type label so file metadata remains consistent with the selected interface language.
- Localize workspace-picker profile and extra-argument accessible labels for English, Chinese, and Japanese users.
- Enlarge archive-browser search and clear controls on touch devices for reliable session-history filtering on phones.
- Enlarge MCP refresh, server selection, add-server, config fields, and action buttons on touch devices for reliable mobile server setup.
- Localize MCP connection, enabled/disabled, off, and invalid status labels for English, Chinese, and Japanese users.
- Localize agent discovery error, warning, and fallback diagnostic messages for English, Chinese, and Japanese users.
- Announce agent discovery errors with alert semantics while keeping warning-only diagnostics polite, so assistive technology distinguishes failures from informational notices.
- Give the archive search clear action an explicit localized **Clear search** accessible label instead of reusing the dialog close label.
- Enlarge agent reload, unpack, create, search, list, copy, save, cancel, and remove controls on touch devices for reliable mobile agent management.
- Localize bundled, user, and project agent scope badges so agent metadata remains readable across supported languages.
- Announce MCP configuration load failures with alert semantics while retaining polite status announcements for live-status connectivity notices.
- Expand the Settings switch hit area to 44px while preserving the existing 40×24 visual track and focus behavior.
- Replace the text-file viewer’s generic loading label with shape-matched skeleton lines and semantic busy state for smoother first paint.
- Replace the conversation session-loading label with shape-matched skeleton lines and semantic busy state for a calmer chat first paint.
- Enlarge the conversation session retry action on touch devices so a failed session can be recovered reliably from mobile.
- Expose Explorer directory and search loading state through `aria-busy`, improving assistive-technology feedback while mobile file navigation remains touch-friendly.
- Replace the initial workspace-validation label with a shape-matched skeleton and semantic busy state for a calmer first paint.
- Show the Ctrl/Cmd+K shortcut in the command-palette toolbar trigger’s tooltip while retaining the existing accessible shortcut metadata.
- Give the archive search input an explicit localized accessible label instead of relying on placeholder text alone.
- Refresh the OMP version shown in new sessions after a CLI update without requiring an omp-web server restart. Reuse results while executable metadata is unchanged, with a five-minute fallback expiry for launchers. Keep the last known version visible between visits and distinguish initial loading from an unavailable runtime.
- Add `OMP_WEB_DISABLE_AUTOUPDATE` to skip npm/OMP update checks and block in-app self-update actions, preserve the setting in service installers, and show the disabled state in Settings.
- Return browser host-tool and host-URI results as fire-and-forget frames while preserving OMP's original request ID, preventing `open_file` and clipboard bridge calls from hanging.
- Restore copy-success feedback after React Strict Mode re-runs effect setup.
- Cancel queued messages in OMP before removing their chips or recalling them for editing. Failed or timed-out cancellation leaves the message visible; successful recall survives composer remounts without losing newer typing. Requires native `remove_queued_message` support.
- Preserve question-dialog answers and selections when an SSE reconnect replays the same pending request or answer submission fails.
- Keep sent-message copy, edit, and fork actions visible without hover or a reveal tap. Also keep file mention/download, Git open-file actions, and sidebar menus visible alongside their metadata; wrap message actions on narrow screens.
- Expand complete tool inputs inline, including multiline code and edit patches, while keeping command previews compact and output visibility unchanged.
- Keep composer controls on one line, with equally sized Send, Stop, and Queue buttons and model names truncating before short effort labels.
- Align the + button and primary action with matching composer insets.
- Recover saved responses before reporting an empty agent reply after returning to a backgrounded page or PWA. Preserve provider errors and distinguish new runs from older answers.
- Catch up missed conversation entries incrementally after reconnecting or returning to the page, including during active runs. Restore quiet partial responses and live tool output without duplicating history or overwriting newer updates.
- Send prompts with image attachments in full again: commands reach OMP as one unchunked JSONL record. Protocol-v2 `rpc_chunk` framing is outbound-only, so any prompt over 1 MiB was rejected as `Unknown command: rpc_chunk` and reset the session after the prompt-ack timeout.
- Show the **New session** fork action below agent replies as well as user prompts, so the newest message in a conversation can fork the session. omp's `branch` command accepts a user entry only, so each reply forks at the prompt that started its turn; replies with no earlier prompt keep no fork action.
- Count subagents, advisors, `/tan` clones and extension helper sessions in Settings → **Usage**. Their model usage lives in transcripts inside each session's artifacts folder, which the Usage page never read. It counted only subagent summaries in `task` results, and background subagents leave those empty. These transcripts now count toward the session and project that own them. History copied by `/tan`, `/fork` or a branch counts once and moves to a remaining copy if the original is deleted, and a `task` summary counts only when no copy of its subagent's transcript exists. The `local://` scratch folder is not scanned. The usage cache rebuilds once on first load; when another omp-web version shares it, files that version synced are re-read.
- Show every tool call as its own row. Collapsing a finished turn's process details no longer merges tool calls from separate assistant messages into a single row, and parallel calls are no longer folded behind a summary header such as "Searched 2 times".

---

## [v0.5.0] - 2026-09-12

This release brings live tool-output streaming, a workspace picker for new sessions, voice dictation, new themes, an activity timeline with transcript export, and a redesigned settings experience.

### Highlights

- **Live tool output**: Tool calls now show a running indicator with streamed output while the tool executes, instead of a dead row awaiting the result.
- **Workspace picker for new sessions**: Choose the destination workspace directly above the new-session composer, with workspace names, exact paths, and worktree preservation.
- **Voice dictation**: Provider-agnostic speech-to-text dictation in the composer.
- **New themes**: OMP Midnight plus popular light and dark palettes with previews and CommandPalette support.
- **Activity timeline**: Activity group summaries, a minimap rail, and transcript export.
- **Composer upgrades**: Plus menu, context-ring gauge, context detail panel, and a `/loop` command to repeat a task up to N attempts.
- **Redesigned settings**: Full-page centered layout with a provider grid.
- **Long-session stability**: Targeted cache invalidation, oversized-file handling, better error surfacing, and render optimization.

### Fixes & Improvements

- Keep Cancel and Submit reachable in mobile extension questions by scrolling long questions and answers above a fixed action row and sizing the editor for short viewports.
- Confirm session deletion and workspace removal in dialogs on desktop and mobile. Cancel leaves data untouched; workspace removal keeps files and sessions.
- Center the workspace/session breadcrumb over the conversation column, and keep mobile generation speed and file-panel controls clear of the panel toggle. Explorer actions now have a separate touch-sized toolbar on mobile.
- Keep the top bar on one row with a fixed-width speed readout: compact units such as t/s, kt/s, and Mt/s, and a same-width ~ marker for average speed. The full rate remains in the tooltip; the whole pill hides when it cannot fit, without clipping or scrolling.
- Keep the fixed-width speed readout visible on narrow screens, including 320px: show theme, language, history, branches, and system controls directly when their measured widths fit beside any visible speed readout, and use a More disclosure otherwise, without shrinking touch targets. New-session screens do not reserve space for an absent readout.
- Open the language menu to the right of its left-side toolbar trigger so all options remain visible in the mobile More disclosure and the desktop header.
- Keep resized file panels and their contents inside the window at intermediate widths and non-default interface scales, wrapping file and Explorer actions when space is tight.
- Keep session action menus visible on touch devices beside fixed-width, right-aligned timestamps, with larger tap targets and titles using the remaining row width.
- Keep workspace header action menus visible on touch devices without first selecting or expanding the workspace.
- Keep provider and OMP System navigation in one horizontally scrollable row on narrow screens, and keep Save and Cancel in normal flow with inline save errors.
- Hide the Steer action when the only queued message is already a steer, matching the expanded queue while keeping Edit and Delete available.
- Keep the theme picker inside the mobile viewport by opening it to the right of its toolbar anchor.
- Match browser and installed-app chrome to the selected theme, with OMP Midnight as the launch fallback.
- Open the conversation sidebar on Back before leaving in narrow, overlay-sidebar layouts. On every layout, warn before Back, reload, or close can discard unsent text or attachments. Cancel keeps the current conversation and drafts; switching conversations still preserves drafts.
- Keep unsent-content confirmation active across consecutive Back presses on Android Chrome, including after switching to a new session.
- Some installed browsers cannot close a directly launched app programmatically. After confirming Leave, use native Back or Close if prompted. Chrome may bypass sidebar-first Back until the first interaction after launch, and Android process termination can bypass page warnings.
- Show app-close guidance only in standalone installed apps, never in ordinary browser tabs.

---

## [v0.4.2] - 2026-09-02

### Fixes & Improvements

- Handle provider daily usage windows and Windows npm spawn shells in the self-update flow.

---

## [v0.4.1] - 2026-09-02

### Fixes & Improvements

- Surface quota 429 RESOURCE_EXHAUSTED errors persistently instead of stopping silently.
- Pin the live agent status bar to the top edge of the composer.
- Keep the running indicator visible on selected/hovered sessions.

---

## [v0.4.0] - 2026-09-02

This release adds native autostart services, self-updates, a redesigned top bar, usage analytics, and composer upgrades.

### Highlights

- **Native autostart**: Windows Task Scheduler service, system tray manager, desktop shortcuts, and macOS launchd installer.
- **Self-updates**: Durable auto-update for OMP and omp-web with unified notifications.
- **Top bar redesign**: 3-zone layout with centered breadcrumb, provider cards, and zoom-aware menus.
- **Usage analytics**: Dashboard with persistent SQLite store plus provider usage limits.
- **Composer upgrades**: Tool preset picker, collapsible input, file search in the Explorer, and workspace-level OMP launch arguments.

---

## [v0.3.6] - 2026-08-28

This release adds workspace renaming and reordering, improved context compaction views, prompt queue expansion, and clear network startup banners.

### Highlights

- **Workspace aliases and reordering**: Give your workspaces friendly names and drag-and-drop or use keyboard shortcuts to reorder them in the sidebar.
- **Inspect past context**: Browse full conversation history from before compaction occurred, with accurate before-and-after token counts and compaction method indicators.
- **Queued prompt expansion**: Expand and review queued follow-up prompts before they are sent to the agent.
- **Interactive questions in composer**: Respond to interactive questions from extensions directly inside the chat composer.
- **Accurate live stats**: Live generation speed (tokens per second) is now pulled directly from the agent runtime, and cache hit rates are displayed in both the top bar and session info panel.
- **Helpful network startup banner**: When starting omp-web, the terminal now displays clear, clickable local, LAN, and Tailscale network addresses.
- **Complete Chinese settings localization**: Fully translated Settings, Models, MCP, and Agent configuration screens with smooth hydration.

### Fixes & Improvements

- Fixed the session details popover from getting cut off or hiding message and token numbers.
- Pressing Escape inside popups or dialogs now closes only the dialog without stopping the running agent.
- Tooltips now display properly above open dialogs and modals.
- Enhanced keyboard navigation visibility in the command palette.
- Made archived session recovery safer and improved session file caching on Windows.

### Contributors

Thank you to the contributors who made this release possible:
- @2740653660

---

## [v0.3.5] - 2026-08-21

This release introduces an archive browser for past conversations, live tracking for external CLI sessions, per-chat advisor controls, and a cleaner chat timeline.

### Highlights

- **Archived session browser**: Browse and search archived conversations in a dedicated panel, and restore them anytime without losing data.
- **Live external sessions**: Sessions started directly from the `omp` command-line now show up in the web interface and stream their responses live.
- **Per-chat advisor mode**: Turn the advisor agent on or off for individual conversations, with settings remembered per chat.
- **Cleaner tool-call timeline**: Tool calls and agent reasoning steps now display in a compact, organized timeline with expandable details and side-by-side file diffs.
- **Live speed indicator**: See real-time token generation speed while the agent is responding, along with average speeds for past turns.
- **Simplified model & reasoning pickers**: Redesigned selectors make choosing models and thinking levels quicker and easier on both desktop and mobile.

### Fixes & Improvements

- Fixed focus handling so closing the mobile sidebar never traps keyboard navigation.
- Added web app manifest and icons for installing omp-web directly to your device home screen.
- Server-side network requests now properly respect `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` settings.
- MCP server credentials are now safely preserved when renaming an MCP server.
- Fixed crashes caused by incomplete or manually edited session files.

### Contributors

Thank you to the contributors who made this release possible:
- @gzaripov

---

## [v0.3.4] - 2026-08-20

This release brings persistent visual agent settings, stronger API safeguards, and improved MCP security.

### Highlights

- **Visual agent settings**: Configure agent behavior and visual preferences directly in Settings, with changes saved automatically.
- **Safer MCP credentials**: Project MCP server secrets and tokens are hidden from API responses while being safely preserved during updates.
- **Request size protection**: Added payload size limits to protect agent and file endpoints from oversized requests.
- **Smooth settings editing**: Prevented background settings refreshes from overwriting changes you are actively typing.

### Fixes & Improvements

- Standardized release builds on Node.js 22.
- Normalized line endings and file types across Windows, macOS, and Linux.
- Improved accessibility and visual feedback for interactive buttons.

---

## [v0.3.3] - 2026-08-18

This release improves model search, Windows workspace support, authentication reliability, and text display.

### Highlights

- **Searchable models**: Quickly filter and search through available models directly inside the model selector.
- **Smoother model catalog loading**: Efficiently loads large model catalogs without slowdowns or connection hiccups.
- **Windows drive picker**: Easily select and browse different drives and Git worktrees on Windows.
- **System prompt on demand**: The system prompt now loads on demand for a faster initial chat load.

### Fixes & Improvements

- Better handling of markdown frontmatter and metadata cards.
- Polished sidebar layout and improved text rendering for East Asian (CJK) characters.
- Fixed authentication handshake issues with newer agent versions.
- Safer fallbacks when a selected model is temporarily unavailable.

### Contributors

Thank you to the contributors who made this release possible:
- @flaribbit

---

## [v0.3.2] - 2026-08-17

This release introduces password protection for web access, a redesigned Settings experience, and CLI improvements.

### Highlights

- **Password protection**: Secure your web interface with simple password login and secure session cookies.
- **New CLI flags**: Added `--password`, `--help`, and `--version` command-line options.
- **Redesigned Settings**: Easily search through settings, manage endpoint presets, and configure models with a cleaner layout.
- **Live running sessions**: Running conversations stay clearly visible in the sidebar while keeping updates efficient.

### Fixes & Improvements

- Kept composer controls and thinking toggles accessible while the agent is running.
- Improved initial scroll positioning and prompt helper behavior.
- Fixed pulse animations and status indicators in dark and light themes.
- Polished active folder highlights on Windows systems.

---

## [v0.3.1] - 2026-08-14

This release brings a major redesign of the workspace sidebar and chat composer, along with wider layouts and accessibility fixes.

### Highlights

- **Redesigned sidebar**: Cleaner project grouping and clearer status indicators make navigating multiple projects effortless.
- **Redesigned composer**: Added a dedicated queued follow-up bar so you can queue prompts while the agent is busy.
- **Wider chat workspace**: Expanded the chat column to make better use of widescreen monitors.
- **Universal file attachments**: Attach any supported file type to your chat messages with helpful file icons.
- **Refined typography & details**: Polished code blocks, process details, and spacing across the interface.

### Fixes & Improvements

- Protected attachment reads against file access races and resource leaks.
- Improved file picker filtering and session discovery.
- Fixed sidebar project grouping issues caused by Windows path casing.
- Added proper cleanup for background event streams when switching tabs.

---

## [v0.3.0] - 2026-08-13

This release adds full agent control commands, keyboard shortcuts for models and reasoning, and explicit update notifications.

### Highlights

- **Interrupt & reply**: Stop a running agent response and immediately send a new prompt from the composer.
- **Retry from banner**: Retry failed responses with a single click directly from the error banner.
- **Keyboard shortcuts**: Quickly cycle through models and reasoning levels using handy keyboard shortcuts.
- **Queue mode controls**: Choose between steering and follow-up queue modes directly in the interface.
- **Update notifications**: Replaced automatic background updates with clear update notices and copyable terminal commands.

### Fixes & Improvements

- Smoother live streaming responses and better memory cleanup when sessions finish.
- Improved Windows path comparisons and Git worktree handling.
- Better color contrast, mobile layouts, and screen reader accessibility.

---

## [v0.2.9] - 2026-08-12

This release adds an image lightbox, smoother streaming for long conversations, and configuration safety improvements.

### Highlights

- **Image lightbox**: Click any image in chat to view it in full size, zoom in, or copy it to the clipboard.
- **Collapsible tool calls**: Your preference for keeping streaming tool calls collapsed or expanded is now saved.
- **Smoother streaming**: Long conversations now stream smoothly with significantly reduced lag and fewer unnecessary re-renders.
- **Custom reasoning levels**: Support for custom thinking and reasoning levels defined by external model providers.

### Fixes & Improvements

- Prevented older session data from overwriting newer runs during page reloads.
- Protected MCP configuration files with file locks to avoid corruption during simultaneous writes.
- Fixed upload and path issues on Windows network shares (UNC paths).
- Improved subagent transcript accessibility and retry behavior.

---

## [v0.2.8] - 2026-08-12

This release introduces a dedicated subagent workspace, pinned task plans, and improved session history recovery.

### Highlights

- **Pinned task & subagent panel**: Keep your todo task list and active subagents pinned right above the composer.
- **Live subagent details**: See real-time subagent status, active tools, retries, token usage, cost, and background task markers.
- **Subagent transcript viewer**: Open a dedicated dialog to view final results, live logs, or full transcripts.
- **History recovery**: Subagents from past conversations are now recovered from disk history when you reopen a session.
- **Clean task summaries**: Expanded task cards show concise summaries without cluttering the screen with raw logs.

### Fixes & Improvements

- Restoring a session from a URL now waits until the session is fully loaded.
- Kept project ordering stable and refined dropdowns and toast notifications.
- Improved subagent identifier validation, UTF-8 text handling, and accessibility.

---

## [v0.2.7] - 2026-08-12

This release improves self-update safety with automatic backups, verification, and rollbacks.

### Highlights

- **Safe updates with automatic backup**: Creates a backup before updating the app or agent runtime.
- **Update verification**: Verifies the newly installed binary and launches a test session before marking the update complete.
- **Automatic rollback**: Automatically restores the previous working version if an update fails, preventing broken installations.
- **Package manager detection**: Accurately detects whether you installed via npm or Bun and uses the right tool for the job.
- **Update history in Settings**: View the status and outcome of your latest update attempt directly in Settings.

---

## [v0.2.6] - 2026-08-12

This release expands project workflows, file attachments, subagent visibility, and chat customization.

### Highlights

- **Session import**: Safely import session files into any selected workspace.
- **File attachments**: Attach text and Markdown files directly to your prompts.
- **Searchable model catalog**: Browse and pick models from an expanded, searchable catalog.
- **Web slash commands**: Use convenient slash commands that work seamlessly with the agent.
- **Subagent activity**: Track subagent progress and refresh transcripts in real time.
- **Planning & goals banner**: See task plans and objectives pinned above the composer with live progress timers.

### Fixes & Improvements

- Unified color themes, status badges, and focus rings across all UI components.
- Hardened session import and background process restart behavior.
- Cleaned up assistant message layouts while keeping tool details easily accessible.

---

## [v0.2.5] - 2026-08-10

This release introduces managed project workspaces and improves task tracking and session reliability.

### Highlights

- **Managed project workspaces**: Manage projects in a resizable sidebar with persistent workspace registration and activity grouping.
- **Phase-based task tracking**: Track progress through multi-phase plans with live phase indicators.
- **Smoother session recovery**: Improved session file reading and chat state recovery after disconnections.
- **Reliable in-app updates**: Smoother and more dependable update checks.

---

## [v0.2.4] - 2026-08-10

This release improves streaming scroll stability and simplifies application updates.

### Highlights

- **Stable scroll follow**: Fixed chat scrolling so the view stays smoothly anchored as long responses stream in.
- **Reliable updates**: Streamlined the update flow to use standard npm packages for a smoother upgrade experience.

---

## [v0.2.3] - 2026-08-10

This release improves code readability and visual feedback during streaming.

### Highlights

- **Clearer code blocks**: Refined syntax highlighting and code block styling for better readability.
- **Smooth streaming scroll**: Fixed auto-scrolling behavior so you can comfortably read responses while the agent types.
- **Better completion feedback**: Improved status indicators when the agent finishes answering.

---

## [v0.2.2] - 2026-08-10

This release improves Windows startup behavior and updates project documentation.

### Highlights

- **Clean Windows startup**: Prevented background agent processes from spawning unwanted console windows on Windows.
- **Updated screenshots & config**: Refreshed application documentation, screenshots, and developer settings.

---

## [v0.2.1] - 2026-08-10

This is the initial public release of omp-web: a fast, modern browser interface for the omp coding agent.

### Highlights

- **Live streaming chat**: Converse with the agent with live streamed text, tool call cards, thinking levels, token counts, cost tracking, and context window gauges.
- **Session management**: Switch between conversations, fork threads, branch into alternatives, and restore sessions directly from URLs.
- **Integrated file explorer**: Browse project files with syntax highlighting, Markdown and Mermaid previews, live updates, diffs, and file mentions.
- **Image attachments**: Drag and drop, paste, or pick images to include in your prompts.
- **Comprehensive configuration**: Easily configure providers, models, API keys, OAuth logins, tools, reasoning intensity, system prompts, and skills from the web UI.
- **Productivity features**: Queue follow-ups, enable steering modes, play completion sounds, navigate with a minimap, and use on mobile devices.
- **Global CLI**: Launch easily via `ompweb` on Windows, macOS, and Linux with customizable host and port options.
- **Internationalization**: Full English, Chinese, and Japanese localization with built-in onboarding guides.

### Contributors

Thank you to the contributors who made this release possible:
- @19WAS85
- @AKAZIK-py
- @AyushDubey23
- @GodD6366
- @Kabochar
- @Li7777777
- @MonteNegroX
- @RizzoTho
- @Windrunner20
- @agegr
- @c54444263
- @fallleave001
- @hcnysa
- @huangyuxi99
- @hzdingxb
- @imxyanua
- @isWittHere
- @kaiwishc
- @kerwin2046
- @killersteps
- @kongdd
- @lc-git
- @levinwang6
- @lifu963
- @mike950523
- @molicherry
- @opsCar
- @robinwlive
- @shani-singh1
- @sleepinginsummer
- @sunqing78
- @tura-ai-agent
- @windli2018
- @xCss
- @xiaojueshi
- @zhudatou630
- @zzjcool
