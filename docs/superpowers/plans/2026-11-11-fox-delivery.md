# FOX Native Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Each owner implements only its assigned files; parent integrates and runs checks once after the wave. Steps use checkbox syntax for tracking.

**Goal:** Implement the approved high-autonomy FOX closed loop, not a UI scaffold.

**Architecture:** OMP native goal owns lifecycle/continuation; native custom entries add confirmed scope, assignment and evidence. Existing host bridges execute exact authorized work and existing report transport wakes review once. Native todo remains the only plan.

**Tech Stack:** Next.js/TypeScript Node24 host; installed OMP rpc-ui; plain .mjs extensions; React; node:test and isolated native fixtures.

**Spec:** docs/specs/2026-11-11-fox-delivery-workflow-design.md (approved in conversation).

## Global Constraints

- Work only in /home/telagod/project/foxnio/fox-delivery; active service checkout ompweb must remain untouched.
- No Chief DB, direct JSONL writes, second goal runtime, global settings changes or scope reduction.
- Defaults: four worker slots, 64 automatic logical dispatches, three rework dispatches/item; grant until delivery/Stop/revocation; optional expiry. Native token budget optional, not a total-worker monetary cap.
- One native goal per FOX conversation can span multiple projects.
- Stop means revoke + native goal drop + best-effort worker abort. Explicit user pause never auto-resumes.
- No tests/build/lint/formatters while implementation agents run. Write behavioral regressions; parent verifies the integrated wave. No source-string assertions.
- Do not commit or spawn agents from implementation workers. Exported changes use LSP references first.

## Review Focus

1. Restored/rewound sessions cannot revive revoked permissions or refund counters (native owner + host recovery tests).
2. Stop racing an admitted host tool must close future side effects (host tests).
3. Native report delivery, goal continuation and user prompts must not duplicate turns (real native fixture).
4. Quiet notification policy must not hide input state or stop authorized work (notification tests).
5. Same cwd multiple workers, continuation copies, missing todo IDs must not misassociate work (protocol tests and UI source links).

## Shared interfaces (binding contract)

Native owner defines `lib/fox-goal-types.ts`:

- `FoxGoalTerms { objective:string; projects:string[]; criteria:Array<{id:string;text:string}>; operations:string[]; tokenBudget?:number; expiresAt?:string; maxWorkers:number; maxDispatches:number; maxRework:number }`.
- `FoxGoalCoordination { grantEntryId:string; nativeGoalId:string; planItemRef:string; purpose:"implementation"|"verification"|"evidence"|"rework"; criterionIds:string[] }`.
- `FoxGoalGrant { id:string; goalId:string|null; terms:FoxGoalTerms; epoch:string; createdAt:string; revoked:boolean; paused:boolean }` (paused is grant user-control permission, not mirrored native goal lifecycle).
- `FoxGoalAssignment { id:string; grantEntryId:string; goalId:string; planItemRef:string; purpose:string; criterionIds:string[]; cwd:string; workerSessionId:string|null; workerFile?:string; state:"reserved"|"running"|"settled"|"uncertain"|"closed"; rework:number }`.
- `FoxGoalReview { criterionId:string; decision:"accept"|"reject"; reportIds:string[]; evidence:Array<{kind:"check"|"artifact"|"human"; reference:string; observed:string; revision?:string}> }`.
- `FoxGoalSnapshot { supported:boolean; reason?:string; goal:NativeGoalModeState|null; grant:FoxGoalGrant|null; assignments:FoxGoalAssignment[]; reviews:FoxGoalReview[]; reports:FoxWorkerReport[]; dispatchesUsed:number; todoPhases:TodoPhase[]; recovery:"running"|"next"|"waiting"|"paused"|"uncertain"; updatedAt:string|null }`.
Native goal shape in types: `{enabled:boolean;mode:string;reason?:string;goal:{id,objective,status,tokenBudget?,tokensUsed,timeUsedSeconds,createdAt,updatedAt}}`.

`lib/omp/fox-goals.mjs` is universal validation/projection/constants. Exports:
- `FOX_GOAL_TOOL="fox_goal"`, `FOX_GOAL_COMMAND="omp-web-fox-goal"`, `FOX_GOAL_REPLY_PREFIX="foxnio:goal-reply:"`, `FOX_GOAL_EVENT_PREFIX="foxnio:goal-event:"`, `FOX_GOAL_ENTRY="fox-goal"`.
- `FOX_GOAL_TOOL_DEFINITION`: host tool with `op:"authorize"|"get"|"review"|"settle"|"rebind"`, terms/review/assignment fields as appropriate. Native hook consumes validation+confirmation, persists mutation, emits event receipt; host responds with snapshot/activation result. Only authorize requires user confirmation; mutations require live grant and exact refs.
- `projectFoxGoal(entries, nativeGoal?, todoPhases?)` returns snapshot from native entries; idempotent replay; complete-journal safety controls.
- `parseFoxGoalTerms(value)`, `parseFoxGoalCoordination(value)`, `validateFoxGoalDispatch(snapshot,coordination,{toolName,input,projectKey})` return validated values or throw.
- All native entries use `data:{version:1,op:string,...}`. Ops include consent,bind,control,admit,assignment,settle,review,rebind,recovery,handoff. Native owner owns exact discriminated shape and shares via a short contract file if additions needed.

Extension command protocol (host sends through proc.sendCommand({type:"prompt",message:`/${FOX_GOAL_COMMAND} ${JSON.stringify(payload)}`})):
`{requestId,sessionId,op,...}` ops `get`, `bind` (grantEntryId,goalId,objective), `assignment` (admissionId,workerSessionId,workerFile), `settle` (admissionId,state), `control` (action:pause|resume|revoke|reset), `handoff` (reportIds), `worker-bind` (assignment and terms). Reply notify prefix carries `{requestId,sessionId,data?:FoxGoalSnapshot,error?:string}`. Commands other than handoff MUST NOT invoke model. Handoff is explicit once-only external input through native sendMessage(triggerTurn:true), not another goal loop. Model cannot call internal command through generic host tools.

`fox_goal` hook emits native event `{toolCallId,op,snapshot,consentEntryId?}` so host can recognize exact already-persisted authorize/review action; no model args substitute for this event. Existing dispatch receipt adds provenance `grant` and grantEntryId/admissionId/nativeGoalId. Gate validates current state as well as exact fingerprint; no reuse of per-call confirmed receipt as a grant.

Host owner exports from `lib/fox-goal-service.ts`:
- `getFoxGoalSnapshot():Promise<FoxGoalSnapshot>` (current pointer, no arbitrary session selection).
- `controlFoxGoal(action:"pause"|"resume"|"stop"|"reset"):Promise<FoxGoalSnapshot>`.
- `reconcileFoxGoal():Promise<void>` called by existing service tick; does recovery/report handoff only, never autonomous repeated prompts.

API `/api/fox/goal`: GET snapshot; POST `{action:"pause"|"resume"|"stop"}` with existing same-origin/auth policy and bounded input. Initial consent remains native chat tool, not unauthenticated JSON POST. UI refresh reads GET.

Host `AgentSessionWrapper` additions: `foxGoalCommand(op:string,args?:Record<string,unknown>):Promise<FoxGoalSnapshot>`; `nativeGoal(op:"get"|"create"|"pause"|"resume"|"drop",args?):Promise<{goal:NativeGoal|null;state:NativeGoalModeState|null}>`; `getFoxGoalSnapshot():Promise<FoxGoalSnapshot>`; `closeFoxGoalAdmission()` immediate local gate. Exported helper for parent notifications `foxGoalNotificationContext(sessionId): { automatic:boolean; goalId:string; ownerSessionId:string } | null` in fox-goal-service (derive trustworthy current assignment/native state, not prompt text).

## Task 1: Native contracts and extension ownership

**Owner files:** lib/fox-goal-types.ts (new), lib/omp/fox-goals.mjs (new), lib/omp/fox-goal-extension.mjs (new), lib/omp/fox-native-extension.mjs, fox-dispatch-guard.mjs, fox-report-extension.mjs, fox-reports.mjs; lib/fox-report-types.ts, lib/fox-workspace.ts, lib/fox.ts; corresponding protocol/extension unit tests.

- [ ] Add behavioral tests: revocation over rewind, exact grant/cwd/criterion validation, 64 admissions, max3 rework, four slots and mutating cwd conflict, no completion without received evidence, human versus coordinator reports.
- [ ] Implement pure projection and validators; native goal ID is authoritative; custom grant stores only authorization/association/evidence.
- [ ] Register extension command handlers; persist/await native writes; implement consent via tool hook (timeout120s deny), assignment binding, review gate on native goal complete, recovery markers, single handoff.
- [ ] Integrate existing native scope hook: allow goal get/evidence-gated complete; deny model create/drop/resume bypass; grant receipts permitted independent of legacy proactive string gate but require actual native active goal.
- [ ] Add typed report audience and structured evidence while retaining old reports as readable unverified data. Worker-bound terms become runtime instructions; no human ask for routine technical choices.
- [ ] Update persona to high autonomy and document precise new tool use. No source-text tests.

**Verify after integration:** node --experimental-strip-types --test lib/omp/fox-goals.test.mjs lib/omp/fox-native-extension.test.mjs lib/omp/fox-reports.test.mjs (parent owns command).

## Task 2: Host admission, native lifecycle, recovery and API

**Owner files:** lib/rpc-manager.ts and tests, lib/agent-tools.ts/tests, lib/pi-types.ts, lib/session-context.ts; lib/fox-goal-service.ts (new), lib/fox-goal-journal.ts (new), app/api/fox/goal/route.ts (new), app/api/fox/session/reset/route.ts, lib/fox-service.ts, lib/fox-report-store.ts if needed; host unit tests.

- [ ] Add regression assertions: no grant before confirmation; metadata required in automatic goal; stale receipt after Stop rejected; unknown delivery not retried; native pause respected on recovery.
- [ ] Expose native goal RPC/state (explicit guarded methods, not general unauthenticated passthrough); register fox_goal host tool only for FOX. Preserve native todo IDs.
- [ ] Read native journal complete verified family with bounded existing history worker where applicable. Do not direct-write files. Native extension command/reply transport must handle timeout/identity change.
- [ ] Spawn FOX-specific --config overlays: [] for setup, [rpc] after binding; mode0600, no creds, cleanup on exit. Create native goal paused with continuation off, exact objective bind; settled same-session respawn and resume only authorized grant. Never destroy an unrelated/busy user process.
- [ ] Per-dispatch host recheck grant/policy/control; reserve/create idle/bind worker/send first prompt as one logical action; settle outcome, uncertain crash handling.
- [ ] Integrate existing report receipt then one explicit handoff; native continuation owns subsequent work. Reconcile all unreviewed reports; no observation seen/cap gate on goal work.
- [ ] Control APIs close admission before native pause/revoke/drop; abort workers on Stop; native epoch revoke before reset; ambiguous persistent control never acknowledged done.
- [ ] Recovery respects running/next/waiting/native pause distinctions; native no-progress not restarted by timer.

**Verify after integration:** affected rpc/goal-service unit tests plus native acceptance in Task4.

## Task 3: Goal-oriented UX

**Owner files:** components/FoxGoalPanel.tsx (new), hooks/useFoxGoal.ts (new), components/FoxPage.tsx, components/FoxActivity.tsx, components/FoxWorkerReport.tsx, components/FoxSettings.tsx, lib/i18n/locales/{en,ja,zh-CN}.json, app/fox.css if necessary.

- [ ] Implement useFoxGoal consuming fixed snapshot/API, coalesced refresh + error preserving previous data. No optimistic completed state.
- [ ] Surface native outcome/state, terms/permissions, next native todo step, assignment association, reviews/evidence, unresolved decisions and budgets; unknown not complete.
- [ ] Add Pause/Resume/Stop controls with server result, stopping/error feedback. Scope creation via native FOX chat prompt; no duplicate approval UI/store.
- [ ] Original worker questions remain original dialogs; navigation has explicit return-to-FOX; distinguish human/coordinator report audience.
- [ ] Reset warns about running/unsettled goal work and non-transfer. Responsive accessible UI, existing primitives/styles, all locales.
- [ ] Include goal notification cap setting copy/controls via `/api/fox/service` extra `maxDailyGoalNotifications` default10 (parent implements server config).

**Verify:** actual browser at1280x900 and390x844 after production build, parent performs. No incidental rendering source tests.

## Task 4: Integration, notifications and acceptance (parent)

**Owner files:** lib/fox-service-config.ts and app/api/fox/service/route.ts, notification-routing integration files discovered by targeted reads; new goal-specific notification helper/tests; native opt-in acceptance tests; DESIGN.md/CHANGELOG.md and plan/spec status.

- [ ] Keep observation counters semantics; add maxDailyGoalNotifications default10. Goal notification routing filters automatic routine completed/error events while preserving raw history/input state across all existing outbound sinks.
- [ ] Existing report source IDs and linked human asks remain usable; integrate any interface mismatches without weakening gates.
- [ ] Real isolated native fixture proves authorize → worker → result → review reject → rework → verified review → native complete, with browser absent. Include blocked idle, real goal accounting, duplicated report, policy/Stop/reset races and restart preservation.
- [ ] Test capability failure and no-grant legacy path; run narrow affected tests once, typecheck and build after integration. Fix actual failures and rerun their narrow checks only.
- [ ] Browser verify goal surface + controls, desktop/mobile, error state. Do not modify user's real goal or config to fake acceptance.
- [ ] Update DESIGN/CHANGELOG after smoke proof; remove temporary fixtures. Fresh independent security and workflow reviews of implementation, resolve concrete blockers.

## Preflight and rulings

| Pair/task | Shared boundary | Resolution |
| --- | --- | --- |
| 1 ↔ 2 | fox-goals protocol + exact receipt/commands | Names and schemas above; native owner may add fields but must notify host owner before use |
| 2 ↔ 3 | snapshot and API | Types in Task1, UI follows fixed API; host does not edit UI |
| 2 ↔ 4 | notification context/config | Host exports context helper; parent owns notification pipeline and config |
| 3 ↔ 4 | goal notification setting | UI owns translations and control; parent owns config field/API validation |
| 1 | native custom records vs native goal | No duplicate lifecycle; goal op=create/resume/drop host-only |
| 2 | activation ordering | continuation disabled until bind, then same-session settled respawn |
| 3 | native todo IDs optional | explicit unlinked state, no guessed associations |
| 4 | fixture provider vs real integration | fake model only; real OMP/RPC/process/persistence and host operations |

Ruling: implement in a sibling worktree to protect the active production checkout.
Ruling: independent file slices run concurrently under these fixed contracts; workers skip all checks mid-flight; parent performs integrated verification. This follows repository tool policy over generic sequential subagent defaults.
Ruling: user explicitly approved design and delegated routine implementation decisions; no further execution-method approval is needed.
