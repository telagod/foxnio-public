# FOX high-autonomy delivery workflow

Status: design proposal, awaiting approval; product implementation has not started.

## 1. User intent and selected approach

The user selected a bounded delivery coordinator and explicitly clarified HIGH
autonomy: after receiving an outcome and scope authorization, FOX should continue
implementation, verification, bounded rework and subsequent steps with no browser
open. Only scope/risk expansion or a genuinely human-dependent decision should
require attention. Routine technical choices belong to FOX and its workers.

| Approach | Tradeoff | Decision |
| --- | --- | --- |
| Improve observation and summaries | User still drives each next step | Insufficient |
| Authorized closed-loop delivery | Requires real scope/recovery semantics | Selected direction |
| Discover and execute arbitrary new goals | Unbounded scope; recreates Chief | Not selected |

This revises the blanket prohibition on proactive dispatch in DESIGN.md. It does
not authorize unrelated work or revive Chief. Native OMP owns goal, todo, session,
question, memory and execution lifecycle; foxnio provides cross-project bridges,
authorization checks and read-only presentation.

## 2. Verified native foundation — an important design correction

The first draft unnecessarily described a new goal lifecycle. Builder inspection
found OMP's existing goal runtime. This revision REPLACES that draft, not adds a
second execution driver.

Actual installed binary: `omp/18.18.8`. An isolated no-provider-call RPC probe
successfully exercised `goal get → create → pause → resume → drop → get`.
All responses reported success, the goal ID survived pause/resume, final state
was null, and zero `agent_start` events occurred. Temporary state was removed;
no user's settings, sessions or credentials were used.

A second isolated 18.18.8 probe verified `--config <overlay.yml>` with
`goal.continuationModes: [rpc]`: goal create caused one native model turn against
a local deterministic fixture. Two ordinary processes without the overlay
(before and after) caused zero model turns. No real provider was contacted.
This proves per-process activation, not the full extension/report integration.

Cached OMP 18.13.3 source provides additional implementation evidence (not proof
that every internal detail is unchanged in 18.18.8):

- `src/modes/rpc/rpc-goal.ts:207-264`: RPC operations and one active/paused goal
  per session. `:267-281` adds the goal tool and schedules native continuation.
- `:305-356`: reopening a process restores an active goal as paused.
- `:362-415`: no-progress suppression and all-blocked todo stop continuation.
- `:424-471`: native continuation rechecks idle/admission state and submits a
  `goal-continuation` custom message. No foxnio model loop is necessary.
- `src/goals/settings.ts:27-38`: RPC continuation is opt-in through
  `goal.continuationModes` containing `rpc` (default is interactive only).
- `src/goals/tools/goal-tool.ts:90-105`: native lifecycle and completion tool.

Use those native APIs through installed CLI/RPC. Do not import Bun SDK packages
into the Node server. Runtime capability probes/native acceptance must establish
actual compatibility; a version string or cached source is not enough.

Existing foxnio foundations: native report outbox/receipt (`fox-report-extension`
and `fox-report-store`), exact lineage/cwd host bridges (`agent-tools`,
`rpc-manager`), per-call receipts (`fox-dispatch-guard`), native todo projection,
FOX chat and activity components. These are extended, not replaced.

## 3. Ownership and explicit non-goals

- Native `goal`: objective, identity, active/paused/completed/dropped lifecycle,
  native accounting and continuation/no-progress behavior.
- Native `todo`: plan, phases, actionable/blocked items; no mirrored todo database.
- Native extension entries: scope consent/revocation, assignment references,
  consumed dispatch permissions and evidence reviews. These add cross-project
  semantics absent from native goal; they are not new built-in OMP APIs.
- Native worker sessions: implementation, verification, report evidence.
- foxnio: one signal relay/observation tick, host side-effect checks, disposable
  projections and UI. No persistent job queue or independent goal scheduler.

One native goal is active per FOX conversation. It can cover several projects
and many parallel plan items. This is not one goal per project. An additional
user request is reconciled into the existing outcome/plan; materially expanded
scope requires updated consent, not creation of a hidden second goal runtime.
No automatic inheritance across FOX reset/fork; no project-name-based routing.

No shell/filesystem sandbox is claimed. Identity, cwd, lineage, grant lifecycle
and limits are machine checked; semantic instructions such as “do not deploy”
are worker/native policy obligations, not a guarantee against arbitrary shell
code. Do not build a new isolation system or imply one in UI.

## 4. User workflow

1. FOX resolves the requested outcome, exact projects, scope and acceptance
   criteria. Ask only about ambiguity that changes an important decision.
2. Show one native confirmation of the scope envelope. This authorizes the
   complete bounded workflow, including technical choices, assignment, evidence
   collection and rework. No second enable switch or per-dispatch confirmation.
3. Bind the consent to the native goal and create/update the native todo plan.
4. Dispatch exact native child workers; receive durable reports. Review evidence,
   request missing checks, choose a different method after failure, or advance
   the next dependency. Do not escalate routine engineering decisions.
5. Complete through native `goal complete` only after all criteria pass review
   and assignments have settled. Persist a concise result with evidence links.
6. User controls Pause/Resume/Stop from FOX. Scope changes invalidate old consent;
   reports and memory cannot grant additional authority.

Small/read-only requests need no goal grant. Existing manual coordination remains
available. Existing project `auto` is not itself consent for a new autonomous
goal; after a goal is granted, both confirm and auto projects can execute within
that consent without more prompts. Observe-only projects cannot execute.

## 5. Scope grant and native goal lifecycle

A versioned native extension grant binds the actual native goal ID and objective,
originating user request, owning conversation, native authorization epoch,
canonical project roots, stable criterion IDs, allowed operations and limits.
The native entry ID identifies the grant. No ticket IDs or task table.

Proposed high-autonomy defaults:

- Valid until delivery, Stop or revocation; optional expiry set by the user.
- Four simultaneous assigned workers; one mutating assignment per canonical cwd.
- 64 automatic logical dispatches per grant; three rework dispatches per item.
- Native goal token budget is optional and displayed accurately. Its accounting
  is not advertised as a total cross-project monetary cap: top-level worker
  sessions have their own usage.

These are visible runaway bounds, not normal approval checkpoints. FOX diagnoses
failure and changes method before seeking human help. Exhaustion pauses work
and asks for additional resource authorization, never reports delivery.

Default allowed operations are implementation and verification. If the user asks
for commit/push/deploy, include those in the initial envelope so they do not need
repeated approval later. Otherwise extending to them requires consent. Do not
assume a request to edit includes production deployment or destructive actions.

Initial confirmation is explicit, bounded by a 120-second timeout, with no
implicit approval on disconnect/timeout. `ctx.hasUI` in rpc-ui does not prove a
browser is attached; the host must observe an actual affirmative response.
Grant creation is unavailable to report/background input. The model may propose
terms but cannot approve them. Persist the affirmative consent envelope first
(without a goal ID), including the exact objective. Create and pause the native
goal with RPC continuation disabled, then bind its ID only if the actual
objective exactly matches the confirmed objective. No new automatic agent_start
may occur between consent and durable binding. Binding failure leaves the goal
paused and unauthorized. After settlement, restart that same FOX child with
the continuation overlay, revalidate the binding and resume the native goal.
There is no concurrent replacement runtime. This one-time activation sequence
avoids assuming a nonexistent create-paused RPC or runtime settings command.

Only OMP writes custom entries. Goal status is always read from native goal,
not duplicated into custom records. Gate `goal create/resume/drop/complete`:
model cannot replace/drop the user goal or resume a user-paused/revoked goal;
completion passes the evidence gate below. Authenticated host goal controls
remain available. Forks require new consent. Verified native continuation copies
may retain the goal/grant after family-wide revocation and limits are checked.

## 6. Dispatch binding, authority and counting

Extend FOX host-tool arguments with typed coordination metadata:
`{grantEntryId, nativeGoalId, planItemRef, purpose, criterionIds}`.
Purposes: implementation, verification, evidence collection, rework. Ordinary
non-goal callers retain their existing arguments. Automatic goal calls require
metadata; never derive it by parsing the prompt or a title.

Plan references use native todo IDs where present. Preserve those IDs through
`session-context.ts`, which currently drops them. Otherwise use the exact
phase/content with its establishing native plan-entry reference. Changed or
ambiguous items are unlinked until FOX explicitly rebinds them. No fuzzy match.

Before each side effect the extension persists a native admission with a unique
logical action reference, plan/purpose, canonical target, exact argument digest
and consumed limit. It emits a fresh single-use receipt. Add explicit receipt
provenance `grant`, distinct from per-call `confirmed` and project `automatic`.
The host checks live native goal, grant, policy, epoch, revocation/pause gate,
assignment, limits and exact arguments immediately before executing.

Authorization comes from the actual active native goal plus confirmed scope,
not a prompt prefix, next-turn boolean, or worker-authored grant ID. A native
goal continuation can use the grant without a fresh human request. Observation
turns are not injected into an executing goal; report text never changes scope.
Per-call receipts remain process-bound and expiring. No historical receipt is
reused and no extra “install next turn” model driver is introduced.

One new worker's idle creation, assignment binding and first prompt count as
ONE logical dispatch under one admission. Create with native parent lineage;
persist the assignment and initialize the worker's goal context before prompt.
Each later follow-up counts once; rework also increments that item's rework
count. Once an admission is durably reserved it is not refunded on uncertainty
or failure. Obvious validation rejection before reservation consumes nothing.

A slot is occupied from reservation through assignment settlement/closure,
including idle workers with unresolved assignments. Paused/reset workers still
running count. Read-only work may run concurrently; verification of a revision
waits for its writers to settle. Parallel mutations require separate authorized
worktrees and an integration owner. Purpose labels are coordination rules,
not a shell sandbox.

## 7. Native continuation and worker report handoff

Enable RPC continuation only in the FOX child using `--config <overlay.yml>`.
The launcher writes a mode-0600 temporary YAML overlay with
`goal.continuationModes: [rpc]` after grant binding, or `[]` for grant setup and
ungranted FOX sessions. The file carries no credentials and is removed after
child exit; stale overlays have no authority and are not scanned as grants.
Recreate the overlay from validated native state on each startup. Ordinary
workers/sessions do not receive it; never change global or user project config.

The native goal controller is the only SELF-CONTINUATION driver. Report handoff
is a distinct one-shot external input through OMP's existing admission path,
like a user message or native task completion; it is not another model loop.
Both use the same native session admission/settlement/accounting. Keep
observation-only planning as-is for conversations without a granted active goal.

For worker waits, FOX marks native todo items blocked on the exact assignment.
When no actionable work remains, native goal continuation naturally stops; do
not spin a model while waiting or treat waiting as delivery.

The existing relay reads all native unreviewed report IDs, not just each worker's
latest summary or observation `seen` map. Coalesce reports and persist receipt
first. A new extension report-handoff command identifies the affected native
wait bindings and requests ONE native `sendMessage(triggerTurn:true)` turn when
the coordinator is settled and its goal/grant remain valid. FOX itself reviews
the report and updates native todo; the relay never unblocks or completes an
item on its behalf. Native goal then owns subsequent continuation. This is an
input delivery, not a separate retry loop.
Routine accepted/progress reports do not trigger a turn. Worker terminal result,
actionable coordination question, failure or human answer can trigger review.

Current report delivery rejects unexpected agent invocation; keep durable
receipt ingestion separate from the new explicit handoff command. Serialize
handoff against user input and native pending continuation; if busy, retain the
unhandled native obligation rather than force an abort or mark it handled.
The existing timer is only a reconciliation fallback for lost wake signals.
It must not autonomously prompt a goal that is already continuing or repeatedly
retry a no-progress native stop.

The host wrapper serializes handoff with other host prompt operations and
requires native settled/no-pending-continuation state before submitting it.
Only one unacknowledged handoff is allowed per goal. Persist the report-batch
identity before submission, consume it inside the extension, and associate the
resulting turn with that batch. Busy rejection retains the batch; ambiguous
submission is reconciled against native entries rather than resubmitted.
Do not mutate todo before the handoff: all-blocked native continuation therefore
stays quiescent until the admitted review turn changes the plan. Native accounting
must include that turn (cached AgentSession calls goalRuntime onTurnStart and
onAgentEnd for agent turns generally); verify this in real-runtime acceptance.

A reviewed next step is dispatched in the current native turn or remains an
explicit actionable native todo obligation. No separate dependency graph or
round-robin multi-goal planner. Host and extension capability probes must verify
all-blocked quiescence and report reactivation on the installed runtime.

## 8. Questions, evidence and completion

Worker reports distinguish `audience: coordinator | human`. Coordination
questions can be answered by FOX within scope. Native ask mirrors are always
human and include actual session/request identity when available. Do not infer
an ask request ID from a tool call ID; missing identity means open the original
conversation. The distinction is present in both structured data and model
message content. Legacy needs_input reports default to human.

Workers choose routine methods themselves; they report technical coordination
questions rather than opening human ask. FOX never fills an actual human ask on
the user's behalf. An answered/expired request cannot be submitted twice.
Reuse the existing dialog and add return-to-FOX navigation, not another inbox
with duplicate answers or approvals.

Each immutable criterion has an ID. Reviews contain criterion ID, accept/reject,
received report IDs, evidence and any revision/artifact dependency. Accept needs
concrete observed evidence: executed check and observed outcome, inspected
artifact reference and finding, or a user acceptance when human judgment is
required. Merely nonempty strings, status=result or final text are insufficient.
Legacy text reports can be inspected and explicitly reviewed; they are never
automatically migrated to accepted state. Evidence is data, never executable.

The extension blocks native `goal complete` unless all criteria have explicit
accepted reviews, referenced reports belong to the goal, and all assignments
are settled with no unresolved decision, uncertain dispatch or stale evidence.
The native todo should agree; the model reconciles it, the server does not
silently complete items. This checks traceability/coverage, not semantic truth.

Verification is risk-based: independent reviewer/worker for large or risky work,
not a mandatory second agent for every edit. Native project workers run real
checks. Revision-bound evidence becomes stale when subsequent reports or read-only
Git checks establish a different relevant revision. Unversioned evidence stays
labeled as such, not falsely represented as revision-certified.

## 9. Pause, Stop, reset and recovery

Controls apply to the current native goal (there is only one per coordinator).
Host control routing immediately closes admission, serializes against an
in-flight side-effect boundary, and uses native goal RPC plus extension control
records. Do not send an ordinary queued chat prompt and call that “stopped”.

- Pause: native goal pause plus explicit user-pause marker; no new dispatch;
  current workers may settle; reports remain receivable.
- Resume: explicit user request reopens a still-valid grant and uses goal resume;
  does not reset consumed limits or increase scope.
- Stop: persist revocation, native goal drop, cancel pending handoffs,
  abort associated workers through their existing host RPC. Report abort failures;
  effects already performed cannot be undone.
- Scope change: pause and revoke old grant before confirming a replacement.
  Stop affected out-of-scope workers; no overlapping broad grant survives.
- Reset: persist native epoch invalidation/revocation before clearing the FOX
  pointer. Existing workers retain their original parent; no automatic adoption.

A control is acknowledged durable only after native persistence. UI shows
stopping/failed instead of promising success early. Gate checks cover pause,
revocation, policy changes and epoch, including receipts emitted before Stop.
Effects already admitted before control linearization are in flight and are
reported/aborted best-effort, not falsely promised impossible.

Native journal epoch and revoke records are authoritative; `session.json` is
only the active pointer/cache. Missing or conflicting epoch data fails closed.
Family-wide revocation and budget consumption must survive branch rewind;
compaction/continuation preservation is a required native acceptance scenario.

Native startup pauses formerly active goals. On recovery the host may resume
only a previously authorized, not-user-paused/not-revoked goal with verified
identity and no uncertain side effect. Explicit user pause/stop and native
budget limits never auto-resume. Native no-progress suppression may be only
process memory; do not pretend `goal get` exposes a durable stop reason.
The extension records explicit recovery intent: a running admitted turn, a
concrete unstarted next-step obligation following a durable dispatch/review/plan
change, or waiting for a specific worker/human event. A settled turn with no
such progress records awaiting-event. After restart only interrupted admitted
work or a concrete next obligation can resume; waiting/awaiting-event requires
new external evidence. No timer restarts an idle goal merely because it was
active, and no clone of OMP's private no-progress digest is introduced.
Unclassifiable intent stays paused with its reason visible.

Cross-session dispatch and parent settlement are not atomic. Persist admission
before effects; prove worker binding/prompt acceptance from native records.
If an interrupted action cannot be proved delivered or not delivered, mark it
uncertain, do not blindly retry/create another worker, and inspect the exact
worker. Only unresolved consequential uncertainty is escalated to the user.
No exactly-once guarantee or host retry ledger is invented.

## 10. Observation, execution and notifications are separate

Existing `enabled`, quiet hours and `maxDailyMessages` continue to gate
OBSERVATION turns. Do not silently change the meaning of that setting. Granted
native goals execute independently of all three; no extra enable toggle.

For goal-bound automatic activity, quiet hours apply only to outbound unsolicited
notification delivery, not transcript updates, native execution or report receipt.
Introduce a separately named daily goal-notification cap (default 10) rather than
reusing observation counters. Ordinary progress remains in the UI/digest; only
outcome or genuine decision/failure escalation generates a notification.

Bind outbound notification policy to trusted assignment/current native goal
activity, not session title/prompt. Suppress automatic intermediate completed/error
noise, not raw lifecycle/notification history or input reconciliation. Human
input remains visibly pending; outbound notification respects quiet hours and
is coalesced, not lost. Missing trustworthy context fails open to normal routing.
Independent/unassigned sessions keep existing behavior. Browser, desktop and push
fan-out must share this policy. Server not running means no work; say so plainly.

## 11. UI projection

Keep chat primary. Enhance the existing activity surface with native goal and
plan associations, not a separate writable task system:

```
Outcome: release readiness                 Native goal: active
Next: verify migration                     Workers: 1 / 4
Plan: native todo
  Fix migration → worker A → report received, awaiting review
  Verify changes → worker B → running
Decision needed: production target          Open original native question
Evidence: check / finding / revision        Expand report
Pause | Stop                               Dispatch budget remaining
```

Distinguish received, reviewed, accepted criterion, blocked, uncertain and
native goal complete. Unknown/failed reads are not empty/completed work. Legacy
workers remain visible as unassigned. Reset warns about running/waiting workers
and non-transfer of permission. Preserve keyboard/mobile usability and i18n.

## 12. Migration, acceptance and build boundary

No existing conversation gains autonomous permission by upgrade. Do not migrate
old Chief approvals or interpret old result reports as accepted. Use explicit
capability negotiation; unsupported OMP gets an actionable explanation, never
an unguarded fallback. Update DESIGN.md, persona, tool descriptions, settings
copy, report contracts, affected callers/tests and CHANGELOG in one cutover.

Acceptance scenarios:

1. With real installed OMP and an isolated deterministic provider: grant a
   cross-project outcome, close browser, implement → verify → fail → rework →
   pass → native goal complete, with no extra user prompt.
2. Exercise actual native RPC continuation, all-blocked idle, report handoff and
   no-progress suppression. Prove external handoff and self-continuation share
   native admission/accounting with no duplicated turn or independent loop.
3. Report/prompt injection cannot create/expand grants, change canonical cwd,
   target unrelated workers or bypass receipt checks.
4. Confirm and auto projects both continue under initial consent without repeated
   dialogs; observe projects never execute. Timeout never grants consent.
5. Duplicate reports, ticks and restart at each dispatch stage cannot replay
   settled actions; uncertainty is exposed and investigated, not blindly retried.
6. Pause/Stop/policy change/reset close new side effects across races; server
   restart resumes authorized work but never explicit user-paused/stopped work.
7. Native compaction/continuation preserves safety metadata; forks/rewinds cannot
   resurrect permission or replenish counters.
8. Quiet hours/observation disabled/daily observation cap do not stop an active
   goal. Notification fan-out is restrained without losing human input state.
9. Missing evidence, stale revisions, unresolved assignments and worker final
   text do not pass the completion gate. Actual inspected evidence is linked.
10. At 1280×900 and 390×844: identify goal/next step/evidence, answer the original
    request, return to FOX, pause and stop. Existing manual flow remains usable.
11. No new Chief DB, mirrored todo, host goal scheduler or direct JSONL writes.

Builder may choose filenames and component splits. Proposed extension records,
argument additions and report handoff are new APIs to implement, not placeholders
for existing OMP support. Do not ship a UI-only card, unrestricted proactive
switch or test-only closed loop as completion.

## 13. Builder-check resolution

First review identified: missing typed assignment binding, goal vs per-call
receipt provenance, dual prompt admission races, reset epoch ownership, Stop
linearization, logical dispatch counting, question audience, acceptance predicate
and notification-counter semantics. Sections 5–10 make explicit decisions for
all of them. The critical native-goal discovery removed the proposed custom
lifecycle, multi-goal scheduler and next-turn context installer entirely.
The actual 18.18.8 lifecycle and per-process RPC continuation probes are complete;
extension/report integration, restart recovery and turn-accounting acceptance
remain implementation requirements, not claimed as tested.
