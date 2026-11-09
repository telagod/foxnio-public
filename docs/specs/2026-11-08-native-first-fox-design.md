# Native-first FOX: OMP owns the state, foxnio wires it

Status: native-first implementation in source (2026-11-08), verified against
OMP 18.18.1. `DESIGN.md` now records the current boundary. The baseline analysis
and migration batches below remain the original proposal, with these decisions
superseding its approval and deletion assumptions:

- Native `tool_call` hooks can enforce real confirmation-before-execution
  boundaries. Dispatch uses `ctx.ui.confirm`, not an instruction to call `ask`
  first. The host consumes an exact, expiring, single-use receipt and rechecks
  project policy; a changed resolved destination also invalidates consent.
- Policy values are `observe`, `confirm`, and `auto`. Proactive turns always
  block dispatch and blocking questions. Native ask remains for clarifying
  user-initiated requests, not a parallel approval queue.
- Existing data is not deleted or rewritten. Legacy autonomy is read once in
  read-only mode; `chief.db` and dispatch/preference records remain historical.
  Legacy APIs return 410, and no old approval can authorize execution. Dormant
  compatibility code can be removed separately without migrating old actions.
- Workers use native parent lineage; the UI is conversation-first with an
  on-demand execution list. There is no separate overview/ticket dashboard.
- The loop persists seen/daily metadata, not a pending task/event ledger.
  Native memory tools are enabled by OMP's backend configuration; unavailable
  memory must not prevent FOX startup or be replaced with another store.

The earlier resident-Chief design remains a historical record of Phase B.

## Principle

The user-confirmed rule in FOX's `PREFERENCES.md` (2026-11-08; D1 decides
whether the file itself survives):

> FOX 的设计必须最大限度使用 OMP 原生能力（session/task/todo/ask/memory/
> extension/RPC），foxnio 只做搭线：读取原生状态、转发事件、渲染 UI；
> 不要自建平行的调度器、数据库、任务账本或审批系统。

The current implementation violates that rule in five places: a SQLite control
plane, a JSON dispatch ledger, an approval broker, a preference table, and an
audit table. This design moves the **record of work** onto OMP and leaves
foxnio with the four things OMP genuinely cannot provide: a cross-project read
model, one wake loop, three cross-project session wrappers, and the FOX
persona.

## Summary

| Concern | Today | Target |
|---|---|---|
| Tickets | `chief.db:tickets` + `events` | OMP `todo` tool state, rendered by `ComposerPanels` |
| Approvals | `chief.db:approvals` + broker | OMP `ask` tool, rendered by `ExtensionDialog` |
| Preferences | `chief.db:preferences` + `PREFERENCES.md` | OMP memory (`retain`/`recall`/`memory_edit`) |
| Audit | `chief.db:audit` | session transcripts |
| Dispatch ownership | `dispatches.json` + `taskId` | worker header `parentSession` |
| Autonomy | `chief.db:autonomy` | small policy in `service.json` (host-enforced) |
| Scheduler | 60s tick + dedupe/quiet/cap | same tick, reduced to seen/daily meta |
| Briefing | read-only composition | unchanged |
| Dispatch tools | RPC wrappers | unchanged, minus the ledger gate |
| Persona | `AGENTS.md` | unchanged |

## 1. Current state

### 1.1 Inventory

Line counts are from the working tree on 2026-11-08.

| Module | Lines | Responsibility |
|---|---:|---|
| `lib/chief-store.ts` | 531 | SQLite `chief.db`: tickets, events, approvals, autonomy, preferences, audit, meta. |
| `lib/chief-actions.ts` | 125 | Dispatch policy broker (`observe`/`suggest`/`approve`/`auto`), creates ticket + approval on deny. |
| `lib/fox-tasks.ts` | 160 | `dispatches.json` ledger, `taskId` pairing, follow-up target check. |
| `lib/fox-service.ts` | 239 | 60s tick, FOX session resolution, wake delivery, event→ticket pipeline. |
| `lib/fox-service-core.ts` | 269 | Pure tick planning: dedupe keys, seen/pending, quiet hours, daily cap, retry cap. |
| `lib/fox-service-engine.ts` | 100 | Single-flight tick; loads briefing/config/state; calls observe and wake. |
| `lib/fox-service-state.ts` | 95 | `service-state.json`: seeded/seen/pending/daily persistence. |
| `lib/fox-service-config.ts` | 68 | `service.json`: enabled, quiet hours, daily cap. |
| `lib/fox-session.ts` | 70 | `session.json`: which FOX conversation the server may wake; reset epoch. |
| `lib/fox-workspace.ts` | 140 | FOX cwd + persona `AGENTS.md`. |
| `lib/fox.ts` | 180 | FOX tool policy, `BRIEFING.md` formatter, dashboard metrics. |
| `lib/briefing.ts` | 412 | Read model types + `buildBriefing`. |
| `lib/briefing-server.ts` | 123 | Composes sessions/live/notifications/registry, plus `dispatches.json`. |
| `lib/agent-tools.ts` | 432 | Host tools `list_sessions`, `new_session`, `send_to_session`, `chief_remember`, `chief_ticket_create`. |
| `app/api/fox/*` | 233 | Session pointer, service config, `BRIEFING.md` mirror, workspace. |
| `app/api/chief/*` | 199 | State, tickets, projects, preferences, approvals. |
| `components/ChiefPanel.tsx` | 295 | Tickets, approvals, autonomy, preferences UI. |
| `components/FoxPage.tsx` | 383 | FOX chat + brief + service toggle + `ChiefPanel`. |
| `components/FoxStatus.tsx` | 395 | Right-panel brief; also mounts `ChiefPanel`. |
| `components/sidebar/FoxCard.tsx`, `lib/fox-events.ts`, `lib/briefing-events.ts` | 135 | Sidebar FOX card, ask-event bridge, briefing refresh event. |
| `components/FoxLogo.tsx`, `lib/fox-logo.ts`, `app/fox.css` | 1,623 | Branding and page styles. |
| `hooks/useBriefing.ts` | 96 | 60s briefing poll; mirrors into `BRIEFING.md`. |
| `instrumentation.node.ts` | 146 | Starts the service (`:142`). |

### 1.2 What each module does, and why it breaks the rule

**`lib/chief-store.ts`** — the second database. The schema at `:99-170` creates
`tickets` (`:100`), `events` (`:117`), `approvals` (`:130`), `autonomy`
(`:145`), `preferences` (`:151`), `audit` (`:162`), and `meta` (`:169`). The
file also owns idempotent ticket creation (`:306-341`), event dedupe
(`:403-420`), approval decisions (`:431-457`), preferences and their
`PREFERENCES.md` mirror (`:459-505`), and the UI aggregate (`:515-523`).

Why it violates the rule: every row is a copy of a fact OMP already owns or can
own. A ticket duplicates the model's own work plan; an approval duplicates an
`ask` answer; a preference duplicates memory; an audit row duplicates the
transcript; `autonomy` duplicates policy that could be configuration. The
store also makes foxnio the authority for the lifecycle, so the UI and the
agent can disagree about what is true.

**`lib/chief-actions.ts`** — the second policy engine. `evaluateFoxAction`
(`:56-125`) reads the per-project level and either denies (`observe`,
`:62-69`), allows (`auto`, `:71-74`), or creates a ticket plus a pending
approval (`:76-124`). The approval stores the full action descriptor and is
executed later by `executeApprovedFoxAction` (`lib/rpc-manager.ts:2621-2640`),
re-entered from `app/api/chief/approvals/[id]/route.ts:61`.

Why it violates the rule: a human answer to "may I dispatch this?" is an `ask`
result in the transcript. Persisting a second copy, with its own state machine
(`pending` → `approved`/`denied`/`blocked`), lets a stale authorization
survive the conversation that justified it. It also gives the browser a second
execution entry point, even though that entry point reuses the same host tool.

**`lib/fox-tasks.ts` + `dispatches.json`** — the second task ledger. One record
per accepted `new_session`/`send_to_session` (`:133-160`), a synthetic `taskId`
for worker creation (`:143`), and a follow-up gate that requires the exact
`(taskId, sessionId)` pair (`:98-103`). `lib/briefing-server.ts:74-120` joins
the ledger against the session list to guess each dispatch's state.

Why it violates the rule: OMP already records lineage in the worker's session
header (`parentSession`) and the work itself in the transcript. The ledger
re-derives status from `lastMessageAt` and the live registry, which is
guesswork, and `taskId` exists only because the ledger exists.

**The service stack** — `fox-service.ts`, `-core`, `-engine`, `-state`,
`-config`. `fox-service.ts:27-28` fixes a 60s tick (`:221-228`); `:95-126`
wakes the existing session through `startRpcSession`/`wrapper.send`;
`:128-163` turns attention events into tickets and events. `fox-service-core`
defines `FoxServiceState` (`:31-42`), the caps (`:61-63`), the dedupe key
(`:79-81`), quiet hours (`:119-126`), the tick plan (`:167-252`), and retry
(`:254-268`). `fox-service-state` persists seen/pending/daily (`:47-95`);
`fox-service-config` persists enable/quiet/cap (`:11-25`, `:52-68`).

Why it violates the rule: the *wake loop* is legitimate — OMP has no persistent
scheduler (see §2.1). The *ticket pipeline* inside it is not: `observeEvents`
(`:128-163`) creates a ticket per event, `closeResolvedEventTickets` and
`reconcileAssignedTickets` (`chief-store.ts:368-401`) move them, and
`service-state.json` keeps a pending queue that duplicates what the briefing
already exposes on every tick. Dedupe and the daily budget are the only pieces
that must exist in some form; they do not need a task lifecycle around them.

**`lib/fox-workspace.ts`** — the FOX cwd and persona. `FOX_PERSONA`
(`:14-126`) is a normal `AGENTS.md`, loaded by OMP's context-file discovery.
It is already native and should stay.

Why the *current text* violates the rule: it documents `task=` pairing
(`:34-45`) and `chief_remember`/`chief_ticket_create` (`:88-94`), which only
exist because of the ledger and the store.

**`lib/fox.ts`** — the tool policy and the briefing projection.
`FOX_TOOL_NAMES` (`:33`) restricts FOX to `read`, `grep`, `glob`, `recall`,
`retain`, `reflect`, `memory_edit`; `effectiveToolNamesForCwd` (`:46-48`)
forces that list for the FOX cwd even when the client asks for `full`.
`formatFoxBriefing` (`:61-116`) writes the dashboard snapshot, including a
`## Dispatched work` section that prints `task=...` (`:87-94`).

Why it violates the rule: the tool restriction is the right idea, but the list
omits the two native tools this design needs (`todo`, `ask`). The briefing
formatter also promotes ledger-only fields into the prompt, entrenching the
second model.

**`lib/briefing.ts` / `lib/briefing-server.ts`** — the read model. `Briefing`
(`briefing.ts:60-79`) carries totals, `needsYou`, projects, active runs,
recent activity, and pulse; `buildBriefing` (`:186`) derives it from existing
views. `briefing-server.ts:37-70` composes sessions, live state, notifications,
and the project registry with no writes and no transcript reads; `:74-120` is
the only part that reaches into `dispatches.json`.

Why it (mostly) does **not** violate the rule: this is exactly "read native
state and render it". Keep the composition, the `warnings` behavior, the FOX
cwd exclusion (`:46-47`), and the `days`/`excludeSession` contract. Only the
dispatch section must change source.

**`lib/agent-tools.ts`** — the cross-project wrappers. `AGENT_TOOL_NAMES`
(`:18`) registers `list_sessions`, `new_session`, `send_to_session`,
`chief_remember`, `chief_ticket_create`. The session tools are thin wrappers
over `AgentToolSessionOps` (`:156-176`), with a rate cap and a chain-depth cap
(`:24-42`, `:183-233`). `new_session` (`:373-392`) spawns through
`ops.createSession`; `send_to_session` (`:394-431`) rejects unless
`allowSendTarget` accepts the `(sessionId, taskId)` pair (`:404-406`).

Why it violates the rule: the three session tools are legitimate wiring — OMP's
`task` tool cannot change the top-level cwd (see §2.1). The two `chief_*` tools
and the `taskId` gate are not: they write the second store and enforce the
second ledger.

**`lib/rpc-manager.ts`** — the host side of that wiring. It registers the harness
tools when the Settings gate is on (`:1023-1028`, `:3052-3054`), evaluates the
FOX policy before executing a dispatch (`:1528-1546`), resolves the project ref
from the target session (`:1556-1566`), records the dispatch (`:2584-2620`),
and exposes `executeApprovedFoxAction` (`:2621-2640`). `createAgentToolOps`
(`:2899-2924`) is the only place that maps a tool call to `startRpcSession`;
today it passes no lineage.

Why it violates the rule: the wiring itself is correct — it reuses
`startRpcSession` and `wrapper.send` and never adds a browser execution path.
The violation is the policy/ledger/approval code layered on top.

**API routes.** `app/api/chief/*` (`state`, `tickets/[id]`, `projects`,
`preferences`, `approvals/[id]`) expose the second store to the browser.
`app/api/fox/session` (`:30-97`) validates and records the browser's FOX
session; `app/api/fox/service` (`:16-60`) reads/writes enable/quiet/cap and
forces a tick; `app/api/fox/context` (`:20-50`) writes `BRIEFING.md`;
`app/api/fox/workspace` (`:12-24`) creates the cwd/persona once.

Why they violate the rule: the `chief` routes are pure control-plane CRUD. The
`fox` routes are defensible: they project native state (`BRIEFING.md`), keep a
server-side pointer that OMP has no concept of (`session.json`), and manage the
one policy the tick needs.

**UI.** `components/ChiefPanel.tsx` fetches `/api/chief/state` (`:66`), decides
approvals (`:90`), sets autonomy (`:110`), and edits preferences (`:129`,
`:148`). It is mounted twice: `FoxPage.tsx:339` and `FoxStatus.tsx:375`. The
chat itself already renders native state: `ComposerPanels` renders
`todoPhases` (`ComposerPanels.tsx:324-349`), and `ExtensionDialog` renders the
native `ask` request (`ExtensionDialog.tsx:199-320`, `:491`, `:668`), wired in
`ChatWindow.tsx:1559-1575`.

Why they violate the rule: `ChiefPanel` is a UI over the second store. The
native todo and ask surfaces are already present and already used by every
other session, so FOX gets them for free once its tool list includes them.
The remaining FOX modules — the sidebar card, the ask/refresh event bridges, the
logo, and `app/fox.css` — hold no state and only render or notify; they stay.

## 2. Native capability check

Everything below was checked against the OMP docs shipped with this machine
(`omp://…`) and, where the doc was not explicit, the installed OMP source.

### 2.1 Capability table

| Need | Native mechanism | Verified in | Verdict |
|---|---|---|---|
| Work items | `todo` tool (`init`/`start`/`done`/`drop`/`block`/`unblock`/`append`/`view`) | `omp://tools/todo.md`; statuses `pending/in_progress/completed/abandoned/blocked` | Usable. Session/branch state, no cross-session view. |
| Todo RPC | `set_todos { phases }` → `{ todoPhases }`; persisted on the branch | `omp://rpc.md:156`, `:760-762`; `lib/pi-types.ts:87`, `:142`; `lib/rpc-manager.ts:1827` | Usable, but replaces the whole list; see §3.4. |
| Todo UI | `ComposerPanels` above the composer | `components/ComposerPanels.tsx:324-349`; `components/ChatWindow.tsx:1567-1575` | Already works for any session, including FOX. |
| Approval question | `ask` tool → `extension_ui_request { method: "ask" }` | `omp://tools/ask.md`; `omp://rpc.md:152`, `:737-748`, `:1326-1330`; `lib/pi-types.ts:207-236`; `lib/rpc-manager.ts:659`, `:2342`; `ExtensionDialog.tsx` | Usable. Requires a prompt surface; blocks the turn. |
| Preferences | `retain`/`recall`/`reflect`/`memory_edit` | `omp://tools/retain.md` (`scope: project \| global`); `lib/fox.ts:33` already grants them | Usable by the agent only; the server cannot read/write memories. |
| Audit | session transcript | `lib/session-reader.ts`; `GET /api/sessions/[id]` | Usable; per-session, not a central table. |
| Dispatch lineage | session header `parentSession`; RPC `new_session { parentSession }` | `omp://rpc.md:139`; installed source `src/modes/rpc/rpc-mode.ts:883`, `src/session/agent-session.ts:11222`, `src/session/session-manager.ts:2039-2048`; reader accepts path or id (`lib/session-reader.ts:46-53`, `:70-71`) | Usable, with one caveat: no spawn flag. |
| Scheduler | none | Only internal timers exist: idle compaction (`omp://compaction.md:153-155`) and memory consolidation (`omp://memory.md:174`). No user-facing cron/RPC command. | **Not native.** Keep one foxnio loop. |
| Task cwd | `task` subagents run in the parent cwd; no `cwd` field | `omp://tools/task.md` inputs table and flow step 11 ("Non-isolated spawns call `runSubprocess(...)` with parent cwd") | **Not native.** Cross-project work still needs `new_session`. |
| Top-level session in another cwd | RPC `new_session` / CLI | `omp://rpc.md:139`; `lib/rpc-manager.ts:2934-3043` | Host-only. foxnio must keep the wrapper. |
| Persona | `AGENTS.md` context file, loaded per session | `omp://context-files.md` (native `.omp` provider, user and project scope) | Usable, already in place. |
| Extension ownership | extensions are modules inside one omp process; `triggerTurn`/`aside` can start that session's own idle turn | `omp://extensions.md` runtime model, `:335-336` | Cannot own the cross-session trigger; option C is weaker than the current loop. |

### 2.2 Consequences

- **`parentSession` is not a spawn flag.** OMP writes the header only through an
  in-process `new_session` (`rpc-mode.ts:883` → `agent-session.ts:11222` →
  `session-manager.ts:2039-2048`). A worker spawned by foxnio is a separate
  process, so the host must send `new_session { parentSession }` after the
  readiness handshake and before the first prompt, then adopt the new id from
  `get_state` (`lib/rpc-manager.ts:1848-1858` already does this after a session
  change). The initial session is empty, so no stray transcript is materialized.
- **`todo` belongs to the FOX session.** It survives resume, rewind, fork, and
  branch (`omp://tools/todo.md`), but a FOX session reset starts empty. A
  database would survive that; native state does not. This is a real tradeoff.
- **`ask` is model-initiated.** The host can enforce `observe` and `auto`; it
  cannot verify that the model asked before dispatching. An `ask` level is a
  persona contract, not a host guarantee. Hard approval semantics require a
  stored approval object — the thing this design removes.
- **Memory is agent-only.** `retain` is a tool call; foxnio cannot write a
  memory from a route. A browser "preferences" editor would need a new store.

## 3. Target architecture

### 3.1 Ownership

```text
OMP (authoritative)                       foxnio (wiring only)
────────────────────────────────────────  ──────────────────────────────────────
FOX session + transcript (audit)          /api/briefing read model
todo phases (work items)                 60s wake loop (seen + daily meta)
ask dialogs (approvals)                   BRIEFING.md projection
memory (preferences)                      list_sessions/new_session/send_to_session
worker headers (parentSession)            session.json, service.json
AGENTS.md persona                         FOX page, brief, ComposerPanels, ExtensionDialog
```

### 3.2 State files after migration

| Path | Purpose | Keep? |
|---|---|---|
| `~/.omp/agent/omp-web/fox/AGENTS.md` | Persona, native context file | Keep |
| `…/BRIEFING.md` | Projection of the 7-day briefing for the chat | Keep |
| `…/session.json` | Which FOX conversation the server may wake; reset epoch | Keep |
| `…/service.json` | `enabled`, quiet hours, daily cap, per-project dispatch policy | Keep (policy, not a ledger) |
| `…/service-state.json` | `seededAt`, `seen` keys, `daily` count | Keep, shrink |
| `…/PREFERENCES.md` | Human-readable preference mirror | Decision D1 |
| `…/chief.db` | Tickets, events, approvals, autonomy, preferences, audit, meta | Delete |
| `…/dispatches.json` | Dispatch ledger | Delete |

`service-state.json` shrinks because the tick no longer needs a persisted
pending queue: an event is marked `seen` on a successful wake (or when a capped
day deliberately drops it), so a failed, quiet, or busy tick retries on the next
tick from the same briefing. Attempts stay in process memory (cap 3) and reset on
restart. This leaves `seededAt`, a bounded `seen` map, and the daily counter —
dedupe and budget, not a task lifecycle.

### 3.3 Dispatch policy

Move the four levels to three, in `service.json`, host-enforced:

| Level | Host behavior | Enforced? |
|---|---|---|
| `observe` | Deny `new_session`/`send_to_session`; return a message. | Yes |
| `ask` (default) | Allow the call; the persona requires an `ask` answer first. | No; persona contract |
| `auto` | Allow the call. | Yes |

`suggest` and `approve` both meant "a human must agree"; keeping them apart
only preserved a UI distinction. The enforceable part of the old autonomy
model was always `observe` vs not-`observe`.

### 3.4 What the service does per tick

1. Load the briefing (unchanged, read-only).
2. Extract attention events (unchanged pure function).
3. Disabled or first tick: record the current keys as seen and return (enabling
   later must not replay an old backlog). Busy or quiet: return without a wake
   and leave the events unseen for the next tick. Over the daily cap: return
   without a wake and mark the events seen, so a capped day does not resurface
   the same events tomorrow.
4. Otherwise wake FOX with the event card. The prompt says: read
   `BRIEFING.md`, update your todo list with anything that needs follow-up,
   answer in one short status.
5. On success mark the event keys seen and increment the daily count. On
   failure leave them unseen and retry next tick (up to 3 in-process attempts).

The service **never** calls `set_todos`. It would have to read-modify-write the
model's list, and a race with FOX's own `todo` call would clobber work. FOX owns
the list; the service only tells it what changed.

### 3.5 What FOX does with a dispatch

1. Read the briefing and its todo list.
2. For a new worker: if the project policy is `ask`, call `ask` with the task
   title, project, and intended prompt; only on approval call `new_session`.
3. `new_session` returns the worker id; add a todo item
   `[<project>] <task> — worker <sessionId>` via the `todo` tool.
4. On follow-up, use the worker id recorded in the todo item.
5. Mark the todo item done on a later wake, once the worker is no longer
   running and has replied; the briefing's active and recent sections are the
   signal, and the model does the transition.

`new_session` in the host tool sets `parentSession` to the calling FOX session
when the caller is FOX, so the sidebar tree and any later query can identify
FOX workers without a ledger. `parentSession` is an opaque lineage string, not
a typed foreign key (`omp://session.md:101`); `fork` writes it too
(`omp://rpc.md:258`), so only direct children of FOX match the gate (a fork of
a worker does not). It is a local consistency check, not an authorization
token: anyone who can edit session files can forge the value, which is the same
trust level as the rest of the local session store.

### 3.6 Approval asks: safety and liveness

Two OMP behaviors make a naive `ask` approval unsafe:

- **Timeout auto-selects.** `ask.timeout` defaults to `0` (disabled), but a
  non-zero value auto-selects the recommended option or the first option
  (`omp://settings.md:940`, `omp://tools/ask.md`) — an approval would approve
  itself. Precondition: the deployment keeps `ask.timeout = 0` (the default);
  the agent cannot override the global setting. If a deployment configures a
  timeout anyway, order **Deny first** and omit `recommended`, so the timeout
  fails closed.
- **A pending ask is "busy".** While an ask is unanswered,
  `pendingHumanRequests() > 0`, and `isFoxTargetBusy` (`lib/fox-service.ts:82-89`)
  treats FOX as busy, so the tick coalesces and stops waking it. That is
  correct backpressure — the human is being asked — but it needs an exit: the
  pending ask is already an `input` item in the briefing, so the human can find
  it; answering, cancelling, or restarting the FOX process ends the turn and
  clears the flag; the service must not count the paused wake as a failed
  delivery or replay the event. A stuck ask with no client is not recoverable
  by the service, so **proactive wakes never call `ask` and never dispatch**;
  approval questions belong to user-initiated turns, where a prompt surface
  exists (`omp://tools/ask.md`). With no client, `ask` throws or cancels,
  which ends the turn and returns FOX to idle.

### 3.7 Hard constraints (cannot be natively owned)

1. **No persistent scheduler in OMP.** The 60s loop stays in the Next server.
   It is a trigger, not a state owner. If the server is down, nothing wakes;
   that is already true.
2. **`task` cannot change cwd.** Cross-project work needs `new_session`; the
   three RPC wrappers stay.
3. **Only the host can create a top-level session in another cwd.** `task`
   children share the parent cwd, so foxnio remains the creator.
4. **`ask` cannot be enforced by the host.** Hard approval requires stored
   state; this design accepts the tradeoff (Decision D4).
5. **Native todo is branch state, not a database.** A FOX session reset loses
   the list (Decision D3).
6. **The server cannot read or write OMP memory.** Preferences are agent-owned:
   the user states a rule in chat, and FOX calls `retain` to store it or
   `memory_edit` to correct/forget it. The old `ChiefPanel` preference editor
   disappears; there is no UI list and no Settings path, because the server has
   no memory API. `retain` defaults to `scope: "project"`; `scope: "global"`
   throws under per-project scoping (`omp://tools/retain.md`), so cross-project
   rules require `mnemopi.scoping` `global` or `per-project-tagged`. A UI list
   would need a new store.

## 4. Options

| Option | What changes | Cost | Verdict |
|---|---|---|---|
| **A. Native remap** | Tickets→todo, approvals→ask, preferences→memory, audit→transcript, lineage→`parentSession`; delete `chief.db`, `dispatches.json`, broker, ledger, chief UI/API. | Lose hard `ask` enforcement and DB-durable tickets; keep all four capabilities in native form. Deletes ~1,310 production lines and ~305 test lines. | **Recommended.** |
| **B. Delete the control plane** | Keep briefing + chat + dispatch wrappers; drop tickets, approvals, autonomy, preferences, audit. | Smallest surface, but loses the supervision workflow that motivated FOX. | Fallback if A's soft approval is unacceptable. |
| **C. Move FOX tools/timer into an OMP extension** | The tick and the host tools live in an extension. | Extensions load inside one omp process and die with it (`omp://extensions.md`). They can start an idle turn *in their own session* (`triggerTurn: true`, `deliverAs: "aside"`, `:335-336`), but they have no native API to spawn or reopen another top-level session, cannot observe other sessions' live state, and stop running when the process exits. The Next server would still own the trigger and the RPC wrappers; C only adds a second distribution path. | Reject. |

Recommendation: **A**, because it keeps every user-visible capability while
removing the parallel state. The only regressions are the ones listed in §6;
each is bounded and documented.

## 5. Migration

Each batch is independently shippable and revertible. No batch changes the
briefing read model's contract except the dispatch source.

### Batch 1 — delete duplicate state

**1.1 Lineage.** Add `parentSession` to `AgentToolCreateSessionInput`; in
`createAgentToolOps().createSession` (`lib/rpc-manager.ts:2899-2924`), when the
caller cwd is FOX, send `new_session { parentSession: <FOX session file> }`
after readiness, adopt the new id, then apply model/name/prompt. Keep the
existing accidental-resume guard (`:3035-3044`). Acceptance: a worker created by
FOX has a header `parentSession` that `lib/session-reader.ts:70-71` resolves to
the FOX session id; it appears as a child in the sidebar tree.

**1.2 Replace the follow-up gate.** `allowSendTarget` becomes a native lineage
check: accept when the target session's `parentSessionId` equals the FOX
session id. Delete `isFoxDispatchTarget`, `recordFoxDispatch`,
`recordFoxDispatchResult`, `dispatches.json`, `lib/fox-tasks.ts`, and
`lib/fox-tasks.test.mjs`. Acceptance: a follow-up to a FOX worker passes; a
follow-up to an arbitrary session is rejected with the existing message; no
`dispatches.json` is written.

**1.3 Tickets → todo.** Delete the ticket/event pipeline from
`lib/fox-service.ts:128-163` and `createEngine`'s reconcile/observe hooks
(`:171-177`, `:180`). The wake prompt includes the event card
(`lib/fox-service-core.ts:157-165`) and asks FOX to update its todo. Add `todo`
to `FOX_TOOL_NAMES` (`lib/fox.ts:33`); the persona gains a short "keep your todo
list current" section. Acceptance: a forced error produces one wake; FOX's
`get_state.todoPhases` contains the item; no `chief.db` row is written.

**1.4 Approvals → ask.** Add `ask` to `FOX_TOOL_NAMES`. Replace
`evaluateFoxAction` with a three-level check reading `service.json`; delete
`lib/chief-actions.ts`, `executeApprovedFoxAction`
(`lib/rpc-manager.ts:2621-2640`), and `app/api/chief/approvals/[id]/route.ts`.
Acceptance: `observe` denies at the host; `auto` executes; `ask` renders an
`ask` dialog in the FOX chat and the dispatch runs after the answer; no approval
row exists.

**1.5 Preferences → memory.** Delete `chief_remember` and
`chief_ticket_create` from `AGENT_TOOL_NAMES`, their definitions, and their
handlers (`lib/agent-tools.ts:336-366`). The persona already tells FOX to use
`retain`/`recall` (`lib/fox-workspace.ts:96-109`); drop the `PREFERENCES.md`
sentence (`:94`) unless Decision D1 keeps the file. Acceptance: a stated rule
is recallable in a later FOX session; no `chief.db` write.

**1.6 Remove the store.** Delete `lib/chief-store.ts`,
`lib/chief-store.test.mjs`, `lib/chief-actions.test.mjs`, and the frontend's
`/api/chief/*` fetches once Batch 2 lands. Archive the live database first
(§6). Acceptance: `grep -rn "chief.db\|chief-store" lib app components` is
empty; the server boots; a tick completes.

### Batch 2 — switch the UI data source

**2.1 Remove `ChiefPanel`.** Delete `components/ChiefPanel.tsx` and its imports
(`FoxPage.tsx:16`, `:339`; `FoxStatus.tsx:18`, `:375`).

**2.2 Re-source the workers section.** In `lib/briefing-server.ts:74-120`,
replace the `readFoxDispatches` join with sessions whose `parentSessionId` is
the FOX session id (from `session.json`). Keep the existing `FoxDispatchBrief`
shape minus `taskId`; the first user message is the task text (strip the
`[From session … via foxnio agent tools]` attribution prefix), `projectRoot`
is the project, and live state supplies `running`/`failed`. Acceptance: the brief
shows a worker immediately after `new_session`, with no ledger read.

**2.3 Policy control.** Move the project policy select into the FOX service
settings (the existing `FoxPage.tsx:151-190` block) backed by
`service.json`. Keep the global enable/quiet/cap fields unchanged. Acceptance:
changing a project to `observe` makes the next dispatch fail with the host
message.

**2.4 Native surfaces.** No new panel: the todo list renders above the FOX
composer through `ComposerPanels`, and approvals render as `ExtensionDialog`
(`ChatWindow.tsx:1559-1575`). Acceptance at 1280×900 and 390×844: attention,
workers, todo, and an ask dialog are reachable without opening `ChiefPanel`.

### Batch 3 — clean API, tests, prose

- Delete `app/api/chief/*` (there are no dedicated route tests; the store and
  broker tests were removed in Batch 1).
- Delete the `taskId` argument from `send_to_session` and the FOX persona
  (`lib/fox-workspace.ts:34-45`, `:88-94`); update `lib/agent-tools.test.mjs`.
- Update `lib/fox.test.mjs` for the new `FOX_TOOL_NAMES`; update
  `lib/fox-workspace.test.mjs` persona assertions.
- Update `lib/briefing.test.mjs` only if the dispatch shape changes.
- Update `DESIGN.md:221-277` (boundary and state list) and `CHANGELOG.md` in
  the same release; this spec is the required prior design revision, and the
  `DESIGN.md` change goes through the normal approval gate. Do not edit it in
  this document.
- Acceptance: typecheck, the affected `node --experimental-strip-types --test`
  files, and a manual FOX smoke run (wake, todo update, ask, dispatch, follow-up).

## 6. Risks and rollback

**`chief.db` data.** Before Batch 1.6, write a one-shot export to
`~/.omp/agent/omp-web/fox/archive/chief-<YYYYMMDD>.json` containing tickets,
preferences, and autonomy. Do not migrate approvals: an authorization granted
in a past conversation must not silently execute in a new one. Leave the
original `chief.db` in place (unread) for one release, then delete it. The
export is a file in FOX's cwd, not a new store.

**FOX session reset loses todos.** Native todo is branch state. Mitigate by
exporting the current todo list to `BRIEFING.md` (or a dated file) as part of
the reset flow; accept the gap until then. Do not reintroduce a database for
it.

**Tool-policy change replaces a live FOX child.** `isFoxToolPolicy` compares the
wrapper's tool list (`lib/fox.ts:36-39`); a mismatch destroys the live child
before the next command (`app/api/agent/[id]/route.ts:80-97`,
`lib/rpc-manager.ts:2963-2970`). Deploy while FOX is idle; a running turn is
aborted by design.

**Soft `ask`.** A misbehaving model can dispatch without asking in `ask` mode.
The host still blocks `observe`, and a session can already be prompted by its
user to dispatch. An approval ask is safe only under §3.6's preconditions:
`ask.timeout = 0` (or Deny first with no `recommended`), and a user-initiated
turn. A stuck ask is visible as a briefing `input` item and suspends wakes
until answered or cancelled; if that is unacceptable, keep a single global
`observe` switch and treat dispatch as user-initiated only (Option B). If hard
approval is required, keep the approval table and drop Option A.

**Memory backend off.** `retain`/`recall` are registered only for the
`hindsight` and `mnemopi` backends (`omp://tools/retain.md`); with
`memory.backend` off they do not exist. Under D1 (`PREFERENCES.md` dropped)
there is no fallback: FOX must report that durable preferences are unavailable,
and the service should surface a warning rather than pretend a rule was
stored. Keeping `PREFERENCES.md` as the fallback is the alternative, not an
addition; the two choices are mutually exclusive.

**Follow-up targeting.** Replacing `taskId` with lineage narrows follow-ups to
sessions FOX created, which is the intent. Pre-migration workers have no
`parentSession` and cannot be followed up; create a new worker instead.

**Lineage is metadata, not authorization.** `parentSession` is an opaque
lineage string (`omp://session.md:101`) and `fork` writes it too
(`omp://rpc.md:258`), so only direct children of FOX match the gate and a
forked worker's child does not. Anyone who can edit the session store can
forge the value; the gate is a local consistency check at the same trust level
as the store, not a security boundary.

**Rollback.** Each batch is one commit. Until Batch 3, the old modules and
`chief.db` remain on disk, so a revert restores the previous behavior. After
Batch 3, rollback requires the archived JSON and a revert of the deletion
commits; approvals are intentionally not recoverable.

## 7. Decision record (superseded by Status)

The Status section records the implemented outcome. The table below is the
original proposal; where the two differ, Status wins.

| ID | Question | Recommendation |
|---|---|---|
| D1 | Keep `PREFERENCES.md`? | **Drop it.** Memory is authoritative; a file mirror either needs `write` in FOX's toolset (risk) or a new server store (violates the principle). |
| D2 | Autonomy shape | **Three levels in `service.json`** (`observe`/`confirm`/`auto`). `suggest` and `approve` were indistinguishable in enforcement. |
| D3 | Todo durability | **Accept session-scoped todos**, export on reset. A database for this is the thing we are removing. |
| D4 | Hard approval | **Accept model-mediated `ask`**; keep `observe` as the hard switch. If hard approval is required, keep the approval table and drop Option A. |
| D5 | Lineage mechanism | **Post-spawn `new_session { parentSession }`**, then adopt the id. No header rewriting by foxnio; OMP owns session files. |

## 8. Acceptance

- `GET /api/briefing` is unchanged except that the workers section is derived
  from `parentSession`; no request reads `dispatches.json` or `chief.db`.
- A FOX wake updates the todo list, and the list is visible in the FOX chat
  through `ComposerPanels`; a page reload preserves it.
- A dispatch in `ask` shows an `ask` dialog; approving it spawns a worker whose
  header `parentSession` is the FOX session, and the brief lists it.
- An approval ask runs with `ask.timeout = 0`; if a deployment timeout fires
  anyway, the denial option is selected first (fail closed). A pending ask
  appears as a briefing `input` item and clears on answer or cancel.
- A proactive wake neither calls `ask` nor dispatches.
- A follow-up to that worker succeeds; a follow-up to an unrelated session is
  rejected.
- `observe` denies at the host with a readable message; `auto` allows.
- No `chief.db`, `dispatches.json`, or `/api/chief/*` remains in the tree.
- Typecheck and the affected unit tests pass; the FOX page passes the 1280×900
  and 390×844 checks.

## Appendix: verified sources

foxnio (working tree, 2026-11-08):

- `lib/chief-store.ts:99-170` schema; `:306-341` tickets; `:368-401`
  reconciliation; `:403-420` events; `:431-457` approvals; `:459-505`
  preferences; `:515-523` state.
- `lib/chief-actions.ts:56-125`.
- `lib/fox-tasks.ts:45-46`, `:98-103`, `:110-127`, `:133-160`.
- `lib/fox-service.ts:27-28`, `:95-126`, `:128-163`, `:165-189`, `:217-239`.
- `lib/fox-service-core.ts:31-42`, `:61-63`, `:79-81`, `:119-126`,
  `:157-165`, `:167-268`.
- `lib/fox-service-state.ts:47-95`; `lib/fox-service-config.ts:11-25`.
- `lib/fox-service-engine.ts:39-99`; `lib/fox-session.ts:11-70`.
- `lib/fox-workspace.ts:14-126`, `:128-140`.
- `lib/fox.ts:19-23`, `:33`, `:36-39`, `:46-48`, `:61-116`, `:153-180`.
- `lib/briefing.ts:16-29`, `:45-58`, `:60-79`, `:89-98`, `:186`.
- `lib/briefing-server.ts:37-70`, `:74-120`.
- `lib/agent-tools.ts:18`, `:24-42`, `:156-176`, `:183-233`, `:324-432`.
- `lib/rpc-manager.ts:1023-1028`, `:1528-1546`, `:1556-1566`, `:1827`,
  `:1848-1858`, `:2584-2640`, `:2899-2924`, `:2934-3043`, `:3052-3054`.
- `app/api/fox/session/route.ts:30-97`; `app/api/fox/service/route.ts:16-60`;
  `app/api/fox/context/route.ts:20-50`; `app/api/fox/workspace/route.ts:12-24`;
  `app/api/chief/*`.
- `components/ChiefPanel.tsx:66-162`; `components/FoxPage.tsx:16`, `:151-190`,
  `:339`; `components/FoxStatus.tsx:18`, `:375`; `components/ComposerPanels.tsx:324-349`;
  `components/ExtensionDialog.tsx:199-320`, `:491`, `:668`;
  `components/ChatWindow.tsx:1559-1575`.
- `hooks/useBriefing.ts:16-37`, `:46-93`.
- `instrumentation.node.ts:142`.

OMP docs (`omp://…`):

- `tools/todo.md`; `tools/ask.md`; `tools/task.md`; `tools/retain.md`;
  `memory.md:174`; `compaction.md:153-155`; `context-files.md`;
  `extensions.md` (runtime model, `:335-336`).
- `rpc.md:139` (`new_session`, `parentSession`), `:152`
  (`set_ask_dialog`), `:156` and `:760-762` (`set_todos`), `:258` (`fork`
  writes `parentSession`), `:737-748` (`set_ask_dialog` payload), `:1326-1330`
  (`ask` request shape).
- `session.md:101` (`parentSession` is an opaque lineage string);
  `settings.md:940` (`ask.timeout` default `0`, auto-select when non-zero).

Installed OMP source (18.13.3):

- `src/modes/rpc/rpc-mode.ts:883`;
- `src/session/agent-session.ts:11222`;
- `src/session/session-manager.ts:2039-2048`.
