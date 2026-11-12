# 新项目目录流程设计

日期：2026-11-12。状态：已批准的短设计落盘；实现细节由 implementation worker 按现有约定决定。

## 目标与交互

让添加项目先回答「使用哪个主机目录」，而不是把目录浏览、Git clone 和启动配置同时展开。

```text
添加工作区 → 选择目录
  面包屑 / 可编辑路径 + 前往
  当前层级             │ 选中文件夹的子目录
  文件夹（选中态）     │ 点击子目录向下一层推进
  Git clone ▸          启动配置 ▸
  最终目录（完整路径）
  新建文件夹                  取消   选择此文件夹
```

- 已有目录、新目录使用同一个浏览流程。直接路径输入、面包屑和上级按钮均可导航。
- 无选择时采用当前层级；选择后采用该目录，右栏展示它的子目录。点击右栏项目向下一层推进。
- 导航保留上一幅可读视图，完成后一次性更新层级、选择、子项和路径；过期结果不得覆盖新选择或新输入。加载或路径草稿尚未采用时不可确认。
- 「新建文件夹」打开小对话框，明确显示父目录：选中目录，否则当前层级。名称经首尾空白清理后必须是一个直接子目录名；创建成功自动选中新目录，但不登记项目。
- 创建失败（重名、非法名称、父目录失效、无权限）留在创建对话框，可修改名称重试或取消。不覆盖既有内容，不初始化 Git，不创建其他文件。
- 只有最终确认调用现有项目登记。成功后沿用 refresh → selectCwd → openProject，登记失败保留浏览流程；取消不登记。已真实创建的空目录不会因取消选择而被自动删除。
- Git clone 与 profile/advisor/extraArgs 分别折叠为辅助配置，保持原有参数与 clone 流式进度、取消清理行为；clone 使用最终选中的目录作为父目录。
- 路径与名称的 Enter 遵守中文 IME composition。嵌套对话框复用现有 focus trap/Escape 栈；picker 在主框初始 focus 前让共享 hook 记录原 opener，在子框打开前保存触发按钮，Escape/Cancel/mask 后回到该按钮，创建成功导航期间回到仍可操作的路径输入。主框关闭时回到仍可用的原 opener；不改全局 modal 系统。
- 主框及创建子框的 viewport bounds 按 `--ui-scale` 补偿，真实 Large（120%）同样有效。窄屏保留两栏；路径/分栏/辅助配置所在中部局部滚动，底部确认/取消保持可达；长父目录创建框在其 bounds 内滚动，不隐藏控件或改变全局缩放。

## 已核实的调用链与参考

foxnio：

- `components/sidebar/SectionRow.tsx`、`PlaceholderRow.tsx` 与 shell 的添加状态进入 `components/sidebar/Sidebar.tsx` 唯一 `DirectoryPicker`。
- `components/sidebar/useWorkspaceActions.ts` 的 `addDialog.commit` 调用 `project-requests.addProject`，成功后 refresh、selectCwd、openProject；取消只关闭对话框。
- `app/api/cwd/browse/route.ts` GET 和 `lib/directory-browser.ts` 已约定 realpath、home、目录 symlink、POSIX/Windows/drive 行为。
- `app/api/projects/route.ts` 负责目录验证、Git worktree 主项目归一、登记和启动配置验证，继续使用既有 SQLite metadata，不新增账本。
- `proxy.ts` 已保护全部 `/api/*` 的 Host/Origin/auth；新 POST 沿用此边界。
- `DESIGN.md` 约定 Next.js/Node，不导入 Bun-only OMP SDK。

只读参考：

- `/home/telagod/project/deepseek-harness/packages/client/ui-directory-picker-browse/README.zh.md`。
- 同包 `src/client/DirectoryBrowser.tsx`：Miller 的 parent/selected/child、面包屑/路径、最新意图胜出、嵌套创建后自动选择、最终 Open 才采用。
- `/home/telagod/project/deepseek-harness/packages/client/ui-workspace/src/client/WorkspacePicker.tsx`：已有与新目录只有一个添加入口，目录选择与项目采用分离。

借鉴交互与状态边界，不复制其插件/slot/Host/runtime、千行状态机、输入预览 debounce 或超时升级机制。

## Approaches

1. **采用：扩展现有 DirectoryPicker 与 cwd/browse。** 复用 Next.js/API/i18n/样式/项目登记，Miller 浏览与真实 mkdir 在同一流程闭环；改动边界小且不改变项目身份。
2. 分开「已有目录」与「新项目」向导：重复浏览和确认状态，违背已批准的单入口流程，不采用。
3. 引入 Harness 插件/runtime：带来第二套能力发现、Host 协议与状态，不符合 native-first/Node 边界，不采用。

## 实施边界与接口

- 修改目录 UI、必要的 client-safe 路径 helper、`lib/directory-browser.ts`、现有 browse route、三种 locale、相关行为测试与文档/changelog。
- 在现有 `POST /api/cwd/browse` 接收 `{ parent, name }`，成功 `201 { path }`；已知错误返回 `{ error, code }` 和对应 400/403/404/409，未知错误沿用 `apiErrorResponse`。
- mkdir 先 realpath 现有父目录并验证目录类型，然后不带 recursive 的 `fs.promises.mkdir` 创建一个直接子目录；绝不覆盖。Windows 特有设备名/非法字符/尾点尾空格按平台拒绝；双方路径分隔符、控制字符、`.`/`..` 与空名均拒绝。
- `DirectoryPicker` 的 owner props 与既有登记调用不变；平台根、drive picker、symlink 归一沿用现有约定。
- 非目标：搜索、多选、删除、重命名、Git init、Harness runtime、第二项目数据库、发布/部署。

## 隔离与验收

当前工作树干净，最小就地修改，不创建无必要 worktree，不接触其他 REVIEW 会话。
验证运行使用授权项目内的临时 fixture、独立 Next distDir/port、独立 HOME/XDG/PI_CODING_AGENT_DIR，禁用真实 provider/自动恢复；不写生产 `.next` 或真实项目/会话数据，不重启 30177。

验收覆盖四项：`reference-design`、`existing-directory-flow`、`create-directory-flow`、`ui-regression-evidence`。新增永久测试仅固定真实边界（越界名称、覆盖冲突、导航竞态/IME 等）；实际桌面与窄屏 browser smoke 证明完整 UI、登记和取消，相关目录/clone/Sidebar 检查按最窄范围执行。

授权禁止 commit、push、deploy。交付保持未提交工作树，以内容 SHA-256 指纹而非 commit-certified 状态报告；独立 reviewer 由 FOX 后续安排。

## 实现与证据记录

实现采用点击已选中的左栏条目清除选择，回到当前层级；这让「无选择时在当前层级创建」在非根目录也可直接使用。路径提交/面包屑落地仍尽量按父层级 + 所选目录两栏锚定；父层级不可读时保留可读目标单栏。

已在独立源码快照及其专属 `.next`（`/home/telagod/project/foxnio/.tmp-directory-flow-cf1bca31/source/.next`）、`http://127.0.0.1:30179` 和 inert HOME/agent 中验证桌面、375px 窄屏、320×568 短窄屏与 812×375 横屏；实际检查结果、运行内容指纹及截图保存在 `/home/telagod/project/foxnio/.tmp-directory-flow-cf1bca31/evidence/`。编程启动原拟传 `.next-directory-flow`，但当前 NextCustomServer 不转发 `options.conf`；实际使用的是隔离副本自己的默认 `.next`，不涉及 live checkout 的生产 `.next`。执行记录见关联计划的 Execution ledger；本报告不替代 FOX 的独立 review，也不代表 native goal 已完成。

### Bounded rework R1（scale + focus）

原实现与独立 review 的历史证据保留。R1 通过实际 Settings → Interface Scale → Large（120%）复现：320×568 主框底部615.20px、确认底部602.20px，确认中心无法命中；812×375 主框底部402.91px、footer底部394.72px，部分裁切。独立 review 已记录的 nested dismissal → BODY 作为焦点 bug reproduction。

修复后实测 Large 320×568 主框9.59–558.39px、确认492.59–545.39px；812×375 主框9.59–365.39px、footer316.41–357.20px。两辅助区可展开编辑，Miller 两栏及中部滚动保留；真实580字符父目录让创建框产生滚动，两尺寸实际滚动并点击 nested Cancel 成功。Escape/Cancel/mask/创建成功返回父活动控件，固定viewport主取消返回原opener；Standard 1440×1000 实际设置及创建/登记/取消也已复验。

R1 新证据（before/after rects、computed scale、hit/click、screenshots、10项picker tests、typecheck/lint、15-file delta及隔离收尾）位于 `/home/telagod/project/foxnio/.tmp-directory-flow-r1-f6ae482f/evidence/`；不覆盖旧报告，不代表 native goal 已完成。
