# Project Directory Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for this approved native execution. One writer owns the coupled UI/API flow; FOX arranges independent review after the terminal evidence report.

**Goal:** 用一个分栏目录流程完成已有目录选择、真实新建文件夹与最终确认添加项目。

**Architecture:** 保留现有 DirectoryPicker owner props 和项目登记链；目录层级/选择/子项原子更新。现有 cwd/browse 增加 POST 创建单个直接子目录，Git clone 和启动参数继续走原有 API。

**Tech Stack:** Next.js 16 / React 19 / TypeScript / Node 24 fs.promises；node:test + Testing Library；真实 Chromium smoke。

**Spec:** `docs/superpowers/specs/2026-11-12-project-directory-flow-design.md`

## Global Constraints

- 仅修改 `/home/telagod/project/foxnio` 内任务相关源码和文档；DeepSeek harness 只读。
- 不 commit、push、deploy，不重启生产服务，不覆盖生产 `.next`，不修改用户既有项目/会话数据。
- 沿用 Next.js/API/项目登记/i18n/样式，不导入 Harness runtime 或 Bun-only OMP SDK，不新增项目账本。
- mkdir 仅创建一个直接子目录，不覆盖、不 recursive、不 Git init、不创建无关文件。
- 保留 Git clone、profile/advisor/extraArgs；目录采用只发生在最终确认。
- 当前工作树干净，在现有非 main/master 分支最小就地修改；所有 runtime 验证使用独立 distDir/port/HOME/agent/data roots 和临时目录。
- 永久测试只测可见行为/边界；不加 wiring、source-text、文案或 mock echo 测试；不无故跑全仓 suite。

## Review Focus

- 较早的导航/失败晚于较新选择或路径编辑返回：不能覆盖最终目录或草稿；Task 1 DOM 竞态回归。
- POSIX 根、Windows drive/UNC 根和目录 symlink：面包屑/父层级不得改错目标；Task 1 路径边界测试、Task 3 临时 symlink smoke。
- IME composition 的 Enter：不能导航、创建或登记半成品名称；Task 1/2 DOM composition 回归。
- 名称越界、已有文件/目录/链接、父目录消失/非目录/权限：不产生覆盖或额外文件，并可在原流程重试；Task 2 真实临时 filesystem 回归，Task 3 真实权限 browser smoke。
- 短窄视口与展开 clone/config：确认/取消（含 Cancel clone）始终可达；Task 3 桌面、窄屏和短屏 browser smoke。

---

### Task 1: Unified existing-directory flow

**Files:**
- Modify: `components/DirectoryPicker.tsx`, `app/globals.css`, `lib/i18n/locales/{en,zh-CN,ja}.json`。
- Create: `lib/directory-picker-path.ts`, `lib/directory-picker-path.test.mjs`, `components/DirectoryPicker.test.mjs`。
- Intentionally unchanged: `components/sidebar/useWorkspaceActions.ts`, `app/api/projects/route.ts`（现有确认/取消/失败链可直接复用）。

**Interfaces:**
- Consumes: `GET /api/cwd/browse?path=...` 的 `{ path, parentPath, directories, drives? }`；`comparableProjectPath` 与现有 clone helpers。
- Produces: DirectoryPicker 原 `onSelect(path, launchConfig?)` / `onCancel()` 不变；`getDirectoryBreadcrumbs(directory: string): { name: string; path: string }[]` 为 client-safe 纯路径处理。

- [x] Step 1: 先写边界测试：POSIX/drive/UNC crumbs；延迟 alpha 后选择 beta、延迟导航后继续编辑、loading 时不可最终确认、composition 不提交。断言真实 DOM 目标/输入和确认输出，不断言实现文本。
- [x] Step 2: `node --experimental-strip-types --test lib/directory-picker-path.test.mjs components/DirectoryPicker.test.mjs`，观察缺失的新交互与 helper 导致 RED。
- [x] Step 3: 实现原子 Miller view、最新请求序号与 AbortController、面包屑/直接路径、选中目标 footer；折叠 Git clone 与启动配置，clone parent 改为最终目标，保留 clone stream/cancel。
- [x] Step 4: 同一最窄命令 GREEN；正常浏览/最终登记/取消由 Task 3 真实浏览器验证。

### Task 2: Create one child directory in the picker

**Files:**
- Modify: `lib/directory-browser.ts`, `lib/directory-browser.test.mjs`, `app/api/cwd/browse/route.ts`, `components/DirectoryPicker.tsx`, picker CSS/三种 locale/DOM 测试。

**Interfaces:**
- Consumes: Task 1 当前采用目录（选中目录，否则当前层级）。
- Produces: `createChildDirectory(parent: string, name: string): Promise<string>`；已知失败为 `DirectoryCreationError`（`code`/`status`）；`POST /api/cwd/browse { parent, name } → 201 { path }` 或 `{ error, code }`。

- [x] Step 1: 写真实 filesystem 回归：canonical/symlink parent 只产生空子目录；重名文件/目录/链接内容保留；拒绝 `.`/`..`/绝对路径/分隔符/控制字符/空名；父目录缺失/非目录/无写权限不产生副作用。DOM 回归覆盖所选父目录、创建成功选中但未采用、冲突后改名恢复与 IME。
- [x] Step 2: `node --experimental-strip-types --test lib/directory-browser.test.mjs components/DirectoryPicker.test.mjs`，观察缺失创建能力导致 RED。
- [x] Step 3: 实现非 recursive mkdir、明确状态码与 locale；嵌套创建对话框使用既有 modal 栈，创建期间冻结关闭；成功按 Task 1 导航自动选中，只有最终确认调用 owner。
- [x] Step 4: 同一最窄命令 GREEN；实际 API 状态、权限和最终登记在 Task 3 smoke。

### Task 3: Isolated end-to-end evidence

**Files:**
- Update after smoke: `CHANGELOG.md` 与本 spec/plan 的实际记录；需要时更新 `DESIGN.md` 项目目录契约。
- Throwaway fixtures/scripts/distDir: 仅本任务授权项目内隔离 scratch；交付前移除执行脚本和构建/临时用户数据，保留验证记录与截图证据。

**Interfaces:**
- Consumes: Task 1/2 实际 Next.js UI/API，原 `/api/projects`、`/api/projects/clone`、shared data store。
- Produces: 按四 criterion 的命令结果、真实浏览器截图、内容 SHA-256 指纹与 terminal report。

- [x] Step 1: 复用 `tests/omp-native-env.mjs` 建立 inert agent 与 HOME/XDG/data 隔离；编程调用 Next，实际使用独立源码副本自己的 `.next` 和独立端口，不修改生产 config 或 `.next`。
- [x] Step 2: 在实际浏览器桌面验证：添加入口、typed path、breadcrumb、左右栏推进、已有目录确认与切换、取消不登记；新建在选择/当前层级下落盘、自动选中、重名/非法名/权限失败后恢复；临时 symlink 到正确目录；保存截图与 API/FS 观察。
- [x] Step 3: 窄屏及短屏验证相同添加/新建/取消/错误恢复，展开辅助配置确认底部按钮可见；保留 profile/advisor/extraArgs 的登记值，用本地临时 Git remote 验证 clone 与取消，不访问真实远程/用户仓库。
- [x] Step 4: 执行相关目录/路径/clone/Sidebar tests 与 `tsc --noEmit --incremental false`（必要时针对隔离生成类型调整命令，不写生产构建）；只报告实际结果。
- [x] Step 5: 更新文档/changelog，停止隔离服务，移除 throwaway 执行物；报告真实证据、截图路径和剩余限制，停止写入交给 FOX 独立 reviewer。不提交。

## Execution ledger

- Pre-flight: Task 1 的目标路径供 Task 2 创建父目录与 clone parent 使用；Task 2 返回 canonical 新目录，由 Task 1 同一导航路径采用。Task 3 复用原项目登记接口，owner props 无变化；未发现共享接口冲突。
- Ruling: 遵从明确授权，不运行 skill 的 commit/merge/发布步骤；工作树干净无需 worktree；采用本计划内 ledger 记录而不使用依赖 commits 的脚本。证据用内容指纹；代价是没有 commit-certified 集成证明。
- Ruling: 永久测试限真实边界，完整 UI 用实际隔离 browser smoke；不跑无关全仓 suite。代价是无关子系统不在本次验证结论内。
- Ruling: 本 worker 完成证据报告后停止写入，独立 reviewer 由 FOX 安排，不自行派生一个并行 writer/reviewer。代价是本报告仍等待独立审查，不代表 goal 完成。
- Task 1 UI/path implementation: `node --experimental-strip-types --test lib/directory-picker-path.test.mjs components/DirectoryPicker.test.mjs` observed RED 0/5 then GREEN 5/5. Newest-selection, path-draft, loading-adoption and IME regressions pass; actual registration/cancel awaits Task 3 browser proof. Node printed its existing typeless-package warning; no package type change is in scope.
- Task 2 RED: filesystem creation cases fail because `createChildDirectory` is absent; create dialog case fails on missing New folder; clearing-selection case fails on retaining alpha. The first create fixture run incorrectly used host home for an absent browse query; corrected the test boundary to point at its temporary root before observing the intended UI RED.
- Ruling: clicking the already-selected left row clears selection and adopts the current level; this makes the specified no-selection creation behavior reachable away from filesystem roots. Cost if wrong: users may expect re-click to refresh instead; breadcrumbs/path remain explicit alternatives.
- Task 2 targeted GREEN: `node --experimental-strip-types --test lib/directory-browser.test.mjs lib/directory-picker-path.test.mjs components/DirectoryPicker.test.mjs` → 17 tests, 16 pass, 0 fail, 1 skip (Windows-only names). Create success smoke test now waits for navigation completion, not merely the new draft path, before pressing final confirmation; no React act warnings remain.
- Type integration: `node node_modules/typescript/bin/tsc --noEmit --incremental false` → exit 0, no output; production `.next` not built or changed by this command.
- Ruling: isolated runtime uses a copied source snapshot inside this authorized project with its own `.next`; Next also rewrites generated type/config metadata, so a source snapshot protects the live checkout in addition to its production `.next`. Cost if wrong: later source edits must be copied into the fixture before further evidence is collected.
- Targeted lint: `node node_modules/eslint/bin/eslint.js components/DirectoryPicker.tsx lib/directory-browser.ts lib/directory-picker-path.ts app/api/cwd/browse/route.ts` → exit 0, no output.
- Isolated startup initially found a missing copied runtime asset: `lib/web-password-hash.ts` imports `bin/omp-web-password-hash.js`. Added `bin/` to the isolated source snapshot and restarted only the task's 30179 process; production is untouched. This is a fixture prerequisite, not a product fallback.
- Task 3 browser evidence at `http://127.0.0.1:30179`: desktop 1440×1000 typed path/right-column advance/breadcrumb/existing adoption and cancel passed; before confirm registry was empty, afterwards the correct project was selected. Create in current level then cancel left the empty folder on disk but registry unchanged.
- Desktop real POST results: permission 403 (`access_denied`), invalid name 400, existing child 409, corrected name 201. Symlink parent resolved to canonical alpha; its existing keep.txt stayed unchanged; created child was empty and auto-selected. Final confirm persisted profile/advisor/extraArgs and selected the new project.
- Narrow 375×812 existing/new folder flows, conflict recovery, nested cancel and main cancel passed. At 320×568 with both optional sections expanded: no horizontal overflow, New folder/Cancel top 453 bottom 497, final confirm top 505 bottom 549, all within viewport; browser area 80px.
- Related checks: `node --experimental-strip-types --test lib/directory-browser.test.mjs lib/directory-picker-path.test.mjs components/DirectoryPicker.test.mjs lib/git-clone.test.mjs lib/project-registry-route.test.mjs components/sidebar/Sidebar.flows.test.mjs` → 44 tests, 43 pass, 0 fail, 1 Windows-only skip.
- Clone fixture correction: the original isolated Git insteadOf mapping used file://, correctly rejected by the unchanged production `GIT_ALLOW_PROTOCOL=https:ssh` restriction. Changed only the fixture mapping to supported SSH and local git-upload-pack; no production transport restrictions are relaxed. Failed clone cleaned up and remained retryable.
- Task 1: complete — desktop and narrow browser observed explicit registration, correct selected project and unchanged registry/selection after cancel.
- Task 2: complete — real filesystem/DOM regressions plus browser 400/403/409→201 recovery, selected/current-level parents, empty auto-selected child, and no registration until confirm.
- Task 3 clone proof: supported HTTPS input mapped only in isolated Git config to local SSH git-upload-pack; success produced a real `.git`, correct selected parent and persisted launch config. At 812×375 in-flight clone, Cancel clone top 326/bottom 360 was reachable; cancellation removed the real partial directory and did not register it.
- Evidence correction: cleanup inspection showed `source/.next`, not the requested `.next-directory-flow`. Inspection of `node_modules/next/dist/server/next.js:315-333` explains why: `NextCustomServer.prepare()` forwards dir/port/dev/hostname but not `options.conf`. Actual build root was the independent snapshot's `.next`; corrected spec and evidence metadata. Production BUILD_ID bytes/mtime and 30177 pid 166941 stayed unchanged.
- Task 3: complete — runtime source hashes match all eight changed production UI/API/locale files; screenshots and JSON evidence retained in task evidence root. Browser tabs closed, service stopped, 30179 refused connections; temporary source/build, HOME/agent/data, Git remote and all throwaway scripts removed, leaving only `evidence/`.
- Final isolation: production BUILD_ID SHA256 `ea485ca3260396710042e4e9761bdaef965b713fefd985ff4cb995d9262a4f57` and mtimeMs `1794453380920.4788` unchanged; `ss -ltnp '( sport = :30177 or sport = :30179 )'` showed only original 30177 process pid 166941.
- Review handoff: awaiting FOX's independent reviewer per authorization; no commit/push/deploy, no full-repository suite or production build claimed. Linux actual UI/filesystem verified; Windows-specific filesystem test skipped, drive/UNC path tests passed. Dev-only request cancellation/ECONNRESET diagnostics were observed and did not stop service; no broader runtime reliability claim is made.

## Bounded rework R1 — scale and nested focus

**Authorization:** FOX assignment `f6ae482f`; original implementation/review settled. Only this worker writes. No commit/push/deploy, production restart, shared modal refactor, global scale change or real user-data mutation. Preserve original implementation/review evidence.

**Baseline:** exact prior 15-file manifest `uncommitted-tree-sha256:7cabc5278cc09288d31c76a8d9ccadf3b935a911e05bf8efff91c33b1dcd7926` matched current source before this rework. No concurrent delta found. New evidence root: `/home/telagod/project/foxnio/.tmp-directory-flow-r1-f6ae482f/evidence/`.

**Files / interfaces:** modify only `app/globals.css` (picker viewport/scroll bounds), `components/DirectoryPicker.tsx` (local focus lifecycle), `components/DirectoryPicker.test.mjs` (real DOM focus transitions), and affected DESIGN/CHANGELOG/spec/this plan. Existing picker owner props, browser/API/registry/clone protocols, scale settings and `useModalDialog` remain unchanged.

- [x] R1.1: Copy current source into a new authorized isolated snapshot, use its own `.next`, inert HOME/agent/data and checked-free port `30286`; record actual Large (120%) setting through Settings UI/persisted setting initialization, computed zoom/--ui-scale, viewport, panel/footer bounds and hit results before editing CSS. Never turn a mathematical inference into a browser observation.
- [x] R1.2: Reuse the established `calc(100vw / var(--ui-scale) - 16px)` / `calc(100dvh / var(--ui-scale) - 16px)` convention for shared main/create bounds. If intrinsic content exceeds short-window bounds, keep it locally scrollable rather than hiding controls or changing global zoom. Verify actual Large 320×568 and 812×375; both auxiliary sections, main/nested cancel and Cancel clone must be operable.
- [x] R2.1: Add focus regressions to the existing picker tests before implementation: nested Escape/Cancel/mask returns to an enabled parent control; successful creation focuses an operable parent control after navigation; full parent dismissal returns to its original opener. Reuse real picker/modal behavior and actual filesystem creation, not source-text or mock forwarding checks. Observe RED for the reported bug without re-running the independent review to reconfirm it.
- [x] R2.2: Fix only picker-local focus capture/restoration, before autoFocus/inert can erase opener context. Keep the focus trap/IME/close guards in the existing shared hook. Verify focus stays in the active dialog, returns on each nested close route, and full close returns to original opener.
- [x] R1/R2.3: Exercise actual Large 320×568 and 812×375 plus standard representative selection/create/cancel; record rects, computed scale, focus and actual clicks/hit testing, including real in-flight clone cancel (no need to repeat clone success). Sync modified runtime files into the new snapshot before new-code evidence.
- [x] R1/R2.4: Run only `node --experimental-strip-types --test components/DirectoryPicker.test.mjs`, affected TypeScript typecheck and `eslint components/DirectoryPicker.tsx`; retain exact output. Do not re-run the previous unrelated 44-case collection or full repository suite.
- [x] R1/R2.5: Update only affected docs/changelog, preserve old reports, produce a new exact 15-file content fingerprint with per-file changed/unchanged delta and unchanged runtime SHA list; close browser, stop own service, remove own runtime/source/scripts and send terminal native evidence for bounded delta review.

Pre-flight: R1 CSS bounds and R2 local focus share the same picker surface but no exported contract changes. One writer performs both, then one current-source browser pass proves their combined behavior. Original API/filesystem/clone-success evidence remains applicable only where runtime SHA stays unchanged.

- R1 measured RED (actual Settings UI Interface Scale → Large): stored/attribute `large`, computed zoom/--ui-scale `1.2`. At 320×568 main panel top=-47.1875, bottom=615.203125, height=662.390625; confirm bottom=602.203125 and centerHit=false. At 812×375 expanded main panel top=-27.890625, bottom=402.90625; footer bottom=394.71875 (partially cropped although center hit succeeds). Nested 320 create happened to fit, but shared bounds still need the same zoom contract. Exact geometry/screenshots in new `before-large-bounds.json`.
- R2 RED: new focus transition cases for nested Escape/Cancel/mask and full-parent close all failed (0/4); existing real-filesystem creation case additionally failed its new post-success focus assertion. Tests use real DirectoryPicker/useModalDialog and focus identity, not source or mock forwarding assertions.
- R1 intermediate: viewport compensation alone contained the 812×375 panel (top=9.59375, bottom=365.390625) but preserved a pre-existing intrinsic-flex flaw: browser height57.59375 < column heading62.984375, and its list painted over the compressed Git summary. A real click was blocked by `.directory-picker-list`. The fix must make the local middle content scroll, retaining usable panes and fixed reachable footer, not merely clip the overflowing child.
- R2 targeted GREEN after local opener/focus handling: `env DEBUG_PRINT_LIMIT=1200 node --experimental-strip-types --test components/DirectoryPicker.test.mjs` →10 pass,0fail. Shared modal hook unchanged; initial focus waits until its external opener capture, nested close restores its saved trigger (or enabled path field during successful navigation), submit parks focus inside the create dialog before controls disable.
- R1 final: added only a picker-local scrolling middle wrapper for path/browser/options; kept header/breadcrumb/selection/footer outside it, shared compensated main/create bounds, two panes and all optional fields. Large320 main top9.59375/bottom558.390625, confirm492.59375–545.390625; Large812 main9.59375–365.390625, footer316.40625–357.203125; enabled footer centers hit, actual cancels/confirm succeeded.
- R1 long-parent actual scroll: 580-character real parent path; Large320 create scrollHeight603/client456/scrollTop147.5, buttons bottom545.765625; Large812 create scrollHeight441/client295/scrollTop146.666656, buttons bottom357.078125. Both panels remain inside their viewport; actual nested Cancel hit, returned to New folder and did not create the draft.
- R1/R2 focus actual: Large320 Escape/Cancel/mask returned to enabled New folder; creation success focused enabled Directory path; same-viewport keyboard and pointer main Cancel returned to original Add workspace. Standard1440 nested Escape/main Cancel also restored correctly. One desktop→mobile resize made the old sidebar opener inert through existing AppShell behavior; this unavailable-opener case is recorded, not claimed fixed or used as passing evidence. No AppShell/global modal change.
- R1 clone cancel: at Large320 Cancel clone430.203125–483, Large812316.40625–357.203125; both actual in-flight clones were cancelled, partial target became ENOENT and registry stayed unchanged. Clone core/protocol unchanged; old success evidence retained rather than rerun.
- Standard1440 actual Settings→Standard computed zoom1: two panes, real empty new child, no registration before final confirm, correct registration/selection afterwards; nested/main cancel did not create draft or alter registry.
- Bounded checks in replacement temporary HOME/agent: `node --experimental-strip-types --test components/DirectoryPicker.test.mjs` →10tests,10pass,0fail; `node node_modules/typescript/bin/tsc --noEmit --incremental false` →exit0; `node node_modules/eslint/bin/eslint.js components/DirectoryPicker.tsx` →exit0. Exact stdout/stderr retained in new evidence `checks.json` and per-command logs. No 44-case/full suite rerun.
- Rework runtime evidence: 14 runtime files matched the actual source snapshot by SHA before shutdown (the 8 original runtime paths plus unchanged shared modal/scale/layout/clone/registration/owner files). Only picker TSX and CSS differ among the original 8 runtime paths; filesystem/API/path/locale hashes remain identical to prior delivery.
- Rework cleanup: managed browser closed; own `fox-dir-r1-f6ae482f` service stopped; 30286 refused connections. Own source/.next, runtime HOME/agent/data, check HOME, Git remote and setup/server/SSH scripts removed, leaving only new evidence. Production BUILD_ID hash/mtime remained unchanged; original implementation/review evidence untouched. No commit/push/deploy/production restart or user-data mutation.
- Rework handoff limits: actual Chromium/Linux, Large320/812 and Standard1440 only; no Windows runtime, production build or full-suite claim. Existing unavailable-opener behavior on desktop→mobile sidebar transitions and existing clone-start focus loss are recorded rather than silently treated as fixed; scoped nested creation transitions and available original-opener restoration are verified. FOX owns independent bounded delta review; this report is not goal completion.
