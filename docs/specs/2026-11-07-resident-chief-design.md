# Resident Chief: read-only briefing first, resident agent second

Status: Phase A, the observation service, and the Phase B control plane
(tickets, approvals, per-project autonomy, explicit preferences, audit) are
implemented (2026-11-08). Autonomous project file edits, spend caps, loop
detection thresholds, routines, and skills remain proposed.

## Implementation status (2026-11-08)

- `lib/briefing-server.ts` is the shared read-only briefing snapshot.
- `lib/fox-service.ts` runs one 60s observation tick in the server process. It
  dedupes attention occurrences, bases the first tick, enforces quiet hours and
  `maxDailyMessages`, coalesces while FOX is running or waiting for a human,
  and retries a failed wake up to three times.
- The service wakes the existing FOX OMP session through `startRpcSession` and
  a normal prompt; it never starts a second runtime or writes project state.
- `service.json` holds the global enable/quiet-hours/cap policy;
  `service-state.json` holds the seen/pending/daily budget; `session.json`
  points at the FOX conversation the browser is using and carries a reset
  epoch/revoked id so an older saved browser id cannot revive a reset
  conversation.
- Event attention creates tickets; `chief.db` holds tickets, approvals,
  per-project autonomy, preferences, and audit.
- Observation/ticket writes are gated on the service being enabled; a disabled
  service only advances its baseline/dedupe state.
- FOX dispatches are gated by `lib/chief-actions.ts`: observe records only,
  suggest/approve create a ticket plus approval, auto executes. Approval
  execution re-enters `executeAgentTool` through `lib/rpc-manager`, so OMP's
  session operations remain the only execution path.
- The FOX page exposes tickets, approvals, autonomy, and preferences; mobile
  has a collapsible Chief sheet. Worker completion reconciles a ticket to
  `review`; the user can mark it done.
- `chief_remember` mirrors explicit rules to `PREFERENCES.md`;
  `chief_ticket_create` records explicit work without starting a worker.
- The wake prompt is observe/suggest only. Hard action authorization is the
  approval gate; direct project file editing by FOX is still disabled.

## Goal

foxnio should let one person supervise many projects without opening every
conversation. A resident Chief answers three questions, in order:

1. What needs me now?
2. Is the system healthy and doing the right things?
3. What happened to one piece of work?

The first release is a read-only briefing over existing state. The second
release adds a resident OMP session that can act, but only through the
existing session/RPC boundaries and only under an explicit policy.

## Why now

A workspace with dozens of projects produces more sessions and notifications
than one person can inspect. The sidebar and notification history show what
happened, but not what deserves attention now. The fix is not a bigger chat
window; it is one coordinator that reads the existing state, summarizes it,
and earns the right to act.

## Principles

- **Attention is the budget.** Every message, question, and notification must
  cost less than the action it enables. Default to quiet.
- **OMP remains authoritative.** Sessions, credentials, providers, agent
  behavior, project registry, usage, and notifications keep their current
  owners. foxnio does not invent a second data format.
- **Observe before act.** The first release writes nothing. The second starts
  in observe/suggest and widens only with an explicit policy.
- **Structured output, not free-form HTML.** The Chief emits a schema; foxnio
  renders it with existing tokens and components.
- **Approval is a first-class object.** A question, a permission, and a
  decision are records, not lines buried in a transcript.

## Non-goals

- A second agent runtime or a second model loop.
- A parallel project/session store. Project and session identity stay in
  `projects.json`, the session reader, and OMP's session files.
- Unbounded autonomy or a general remote-control plane.
- Replacing OMP memory, credentials, providers, or agent behavior.
- An internet-facing multi-user service.

## Approaches

| Approach | What it is | Tradeoff |
|---|---|---|
| **A. Read-only briefing** | Aggregate existing state into one screen. No LLM, no scheduler, no writes. | Fast, safe, immediately useful; no proactive work. |
| **B. Resident Chief session** | An ordinary OMP session woken on events/schedules; acts through existing RPC/session operations; a small control-plane store for tickets, approvals, audit, and preferences. | Fits the OMP boundary; adds scheduler and governance work. |
| **C. Standalone orchestrator daemon** | A separate process and database that owns tasks and spawns agents. | Strong isolation; duplicates state and conflicts with `DESIGN.md`. |

Chosen approach: **A first, then B**. C is rejected.

## Phase A: read-only briefing

### Data sources

| Source | Existing code | Use |
|---|---|---|
| Sessions | `lib/session-reader.ts` (`listAllSessions`) | project grouping, last activity, counts |
| Live runs | `lib/rpc-manager.ts` (`getLiveRpcSessionStates`, `pendingHumanRequests()`, `lastRunErrorMessage()`) | running, pending-input, and last-run error state |
| Notifications | `lib/notification-store.ts` (`listHistory`) | optional unread enrichment; never the only source |
| Projects | `lib/project-registry.ts` + `/api/projects` discovery | canonical project name/path |
| Git (optional) | `lib/git-status.ts` | dirty file count and branch for recent projects |

Notification history is written only when a device has notifications
enabled, and its id is a `<sessionId>:<type>` replacement tag, not an event
stream. Phase A therefore derives `needsYou` from the live RPC registry and
session activity; history is only an optional cross-check for unread
notifications when a device has it. A
default install still sees live waiting sessions, and the briefing remains
zero-write.

No new persistent store. No LLM call. No write to OMP state.

### Model

```ts
type BriefingItemKind = "error" | "input" | "blocked" | "activity";

interface BriefingItem {
  id: string;                 // stable dedupe key
  kind: BriefingItemKind;
  sessionId: string;
  sessionName: string | null;
  projectKey: string;
  projectName: string;
  detail?: string;
  at: string;                 // ISO timestamp
}

interface ProjectBriefing {
  key: string;                // canonical project path
  name: string;
  path: string;
  sessions: number;
  running: number;
  waiting: number;
  errors: number;
  unread: number;
  lastActivity: string | null;
  git?: { dirty: number; branch?: string };
}

interface Briefing {
  generatedAt: string;
  totals: { projects: number; sessions: number; running: number; waiting: number; unread: number };
  needsYou: BriefingItem[];
  projects: ProjectBriefing[];
  recent: BriefingItem[];
  warnings?: string[];
}
```

### Rules

- `needsYou` order: `error` > `input` > `blocked`. Deduplicate by
  `sessionId:kind`; one row per session per reason.
- `input` means the session is waiting for a human: a live session with
  pending UI requests, or an unread `input` notification. The sidebar's
  waiting badge uses the unread notification; this adds live pending requests
  without introducing a second kind. One row per session.
- `error` comes from the live wrapper's `lastRunErrorMessage()` (cleared on
  `agent_start` and a successful prompt) or an unread `error` notification.
- `blocked` is reserved for Phase B tickets; Phase A leaves it empty.
- `recent` holds up to 20 recent session-activity rows (kind `activity`) from
  the last 24 hours, ordered by `lastMessageAt`. It is not a completion log;
  a session appears at most once.
- `ProjectBriefing.waiting` and `totals.waiting` count sessions with an
  `input` item; they do not introduce a second waiting kind.
- `days` (default 7, 1–30) limits the session set: only sessions whose
  `lastMessageAt` falls inside the window contribute to `projects`, `totals`,
  and `recent`. It does not filter notifications.
- An empty `needsYou` list is a valid, quiet result; the UI shows
  "Nothing needs you" and the project count.
- A source failure never blanks the page: return the other sections plus a
  `warnings` entry naming the failed source.
- The optional `excludeSession` query parameter removes the session the user is
  currently viewing from `needsYou` (it stays in `projects` and `recent`).

### API

`GET /api/briefing?excludeSession=<id>&days=7`

- Same auth and origin checks as other GET routes.
- `Cache-Control: no-store`; the server may reuse the session reader's 30s
  cache.
- `days` limits the session lookback (1–30, default 7); `recent` stays
  capped at 20 items / 24 hours.
- No writes. No host execution. No browser-driven commands.

### UI

- A pinned **FOX** card sits above the workspace tree. It shows projects,
  running sessions, needs-you, and a 24h sparkline.
- Clicking the card opens the FOX workspace at `?fox=1`. While it is open,
  every workspace group folds and the tree is pushed to the bottom of the
  sidebar; the card is the only header affordance for FOX.
- The workspace renders the briefing as a dashboard: needs-you, project
  health bars, a 24h pulse, and recent signals. A resident chat sits below it.
  The first prompt creates an ordinary OMP session in
  `~/.omp/agent/omp-web/fox`; later visits resume the stored session.
- The FOX page and card fetch `/api/briefing` on mount and every 60s (the card
  skips the request when no `onOpenFox` is supplied, e.g. in tests).
- `BRIEFING.md` is mirrored into the FOX cwd with the same 7-day snapshot so
  status answers in chat match the dashboard.
- The existing **Briefing** icon remains a quick read-only modal.
- Phone: the card is compact, the workspace folds below it, the dashboard
  stays single-column and the chat keeps its composer.
- Closing FOX removes `?fox=1` and returns to the previous chat.

### Performance

- Reuse `listAllSessions()` (30s TTL); do not scan session files again.
- Do not run Git status for every project on first paint. For the 10 most
  recently active projects, run `getGitStatus` with concurrency 2 and render
  the card skeleton until it resolves.
- Do not scan `usage.db` in v1; the existing Usage tab already reports usage.
- The FOX card and workspace share a 60s briefing refresh; the page posts the
  snapshot only when the briefing object changes.

### Acceptance

- `GET /api/briefing` returns the schema for empty, one-project, and
  many-project fixtures, including the 24-bucket `pulse`.
- The FOX workspace answers "what needs me now" on one screen at 1280×900 and
  390×844; the brief may scroll but its panels stay reachable.
- The Phase A modal writes nothing; the FOX workspace writes only its own
  `AGENTS.md` and `BRIEFING.md` under `~/.omp/agent/omp-web/fox`.
- Session tabs, notifications, and usage views are unchanged; the sidebar
  gains the FOX card and folds workspaces while FOX is active.
- Unit tests cover briefing pulse buckets, project ranking, hidden FOX paths,
  and the sanitized chat snapshot.

## Phase B: resident Chief

### Identity and runtime

- One ordinary OMP session titled **FOX**, cwd
  `~/.omp/agent/omp-web/fox`.
- Pinned at the top of the sidebar above the workspace tree; same session
  files, model configuration, and approval policy as any other session. The
  Phase A chat uses the normal tool set; Phase B will restrict it to `chief_*`
  broker tools plus read-only knowledge tools.
- Not a new runtime. Worker sessions are ordinary sessions spawned through
  `new_session` and driven through `send_to_session`.

### Service

`lib/chief/service.ts`:

- Started from `instrumentation.node.ts`; guarded by
  `globalThis.__foxnioChief`.
- One single-flight tick per 60s. Event subscriptions to the running-session
  bus and notification hub debounce into one coalesced wake.
- Persisted `nextWakeAt` and `lastTickAt` in `chief.db`.
- Wake only when `shouldWake()` is true: outside quiet hours, daily message
  budget remains, and at least one actionable event exists.
- Wake by delivering a compact event card through the existing RPC delivery
  path. If the Chief is running, store one pending card and coalesce; never
  queue unbounded wakes.
- Stop with the server; no orphaned timers.

### Action broker

`lib/chief/actions.ts` is the only path for project-affecting actions.

- `authorize(action, project)` checks the project autonomy, the policy, the
  daily caps, and the loop detector. It returns `allowed`, `needs_approval`,
  or `denied` plus a reason.
- `execute(action)` performs an allowed action through existing
  `new_session` / `send_to_session` / `deliverToSession` and the existing
  worktree/Git APIs.
- An approval stores the full action descriptor (kind, project, arguments,
  scope, evidence). On approve, the broker executes that descriptor; the model
  never re-sends the action.
- Autonomy changes are evaluated by the broker per call, so no Chief restart
  is needed.
- If an OMP UI request ever reaches the Chief session, the service denies it,
  records an audit row, and turns it into a pending approval instead of
  leaving the run blocked.

### Control-plane store

`~/.omp/agent/omp-web/chief.db` (SQLite, beside `notifications.db`):

| Table | Holds |
|---|---|
| `tickets` | the unit of authorized work |
| `events` | deduped triggers and dispositions |
| `approvals` | pending, approved, and denied human decisions |
| `preferences` | learned rules with source, confidence, scope, and status |
| `audit` | append-only wake, decision, tool, message, and transition records |
| `meta` | schema version, policy version, schedule state |

No `projects` table. `project_ref` is a path/key resolved through
`project-registry.ts` and the session reader.

### Control-plane writes

The Chief writes tickets, approvals, preferences, and reports only through
server-side host tools (`chief_ticket_create`, `chief_ticket_update`,
`chief_report`, `chief_ask`, `chief_remember`, `chief_briefing`). Each tool
validates its arguments, writes to `chief.db`, and appends an audit row before
returning. The service does not parse the Chief's final text for structured
output; a malformed tool call is rejected and the model may retry once.

### Ticket and mandate

```ts
interface Mandate {
  kind: "explicit" | "rule";
  requestedBy: string;
  ruleId?: string;
  scope: string;
  policyVersion: string;
}

interface Ticket {
  id: string;
  projectRef: string;
  triggerId: string;
  title: string;
  state: "inbox" | "assessing" | "queued" | "working" | "waiting_human" | "review" | "done" | "dropped";
  mandate: Mandate;
  assigneeSessionId?: string;
  proposal?: unknown; // suggest-mode proposal written by chief_ticket_update
  artifacts: string[];
  createdAt: string;
  updatedAt: string;
}
```

Idempotence: `events.dedupe_key` is unique; accepting the same trigger twice
returns the existing event/ticket even if the model never runs.

The service, not the Chief, owns the event-to-ticket pipeline:

- `observe`: write an `events` row with `disposition: "observed"`; no ticket,
  no message.
- `suggest`: write an event and a ticket in `inbox`, wake the Chief to assess
  it, and let `chief_ticket_update` store a `proposal` and move it to
  `waiting_human`. No project writes.
- `approve`: as `suggest`, plus the broker may create an approval for
  destructive or external steps.
- `auto`: as `approve`, plus the broker may execute policy-allowed steps.
- A user request can create an explicit ticket through `chief_ticket_create`
  with `mandate.kind: "explicit"`.

`events.disposition` is one of `observed`, `ticketed`, `ignored`, or
`unavailable`.

### Attention budget

- Default `maxDailyMessages: 3`.
- Quiet hours default 22:00–08:00 local.
- One question per ticket; proactive messages cap at 120 words.
- Batch multiple events into one wake. Send nothing when nothing needs a
  human.
- Notify once per ticket transition; dedupe by `ticketId:state`.

### Autonomy

Per project: `observe | suggest | approve | auto`.

| Level | Behavior |
|---|---|
| `observe` | Record events only. No ticket, no message, no actions. Default for new projects. |
| `suggest` | Create a ticket and store a proposal. No project writes, no worker. |
| `approve` | May spawn a worker, create a worktree, or run tests. External or destructive actions need an approval. |
| `auto` | Actions allowed by the written policy; still audited and capped. Explicit opt-in only. |

Global default: `suggest`. `auto` requires a policy and a per-project opt-in.

### Policy

`~/.omp/agent/omp-web/chief.policy.md`, plain text, versioned by content
hash. It names allowed proactive rules, forbidden actions, and approval
boundaries. The prompt includes it; `lib/chief/actions.ts` enforces it.

### Memory and preferences

- OMP's own memory (`memory.backend`) remains the model's memory for profile
  and project facts; foxnio does not keep a second note tree or project store.
- Preferences are rules, not opaque vectors:
  `{ id, text, scope, confidence, source: "explicit" | "observed", status }`.
- Implicit signals (dismissed reports, edited summaries) create candidates;
  after three consistent observations they become active. The user can edit,
  disable, or delete them in Settings → Chief.
- Never change behavior from a hidden preference; active rules are shown.

### Actions and safety

- All project-affecting actions go through `lib/chief/actions.ts`; it calls
  existing RPC/session operations and existing file/Git/worktree APIs.
- No new browser-triggered host execution path.
- Concurrency cap: 2 active tickets. Loop detection: 3 failed attempts or a
  repeated action hash within 1h → `blocked` plus one notification.
- Optional daily USD budget; the Chief pauses when reached.
- Kill switch: `chief.enabled=false` stops wakes; running sessions continue.
- Audit every wake, decision, tool call, approval, message, and transition.
  Retention 30 days; the user can clear it.

### UI

- FOX card pinned above workspaces with status (idle/thinking/needs you);
  clicking it opens the workspace and folds the workspace tree to the bottom.
- The workspace already carries the 7-day dashboard and resident chat; Phase B
  adds **Tickets** and **Approvals** sections.
- Settings → Chief: enable, autonomy per project, quiet hours, daily message
  budget, spend cap, learned preferences, audit, pause.
- The approval dialog shows the stored action descriptor, scope, and
  evidence; approve executes it through the broker, deny records the decision.

## Contract addendum

Add to `DESIGN.md` (proposed, not implemented):

```md
## Proposed: Resident Chief (not implemented)

A future resident Chief is an ordinary OMP session woken by foxnio on events
and schedules. foxnio runs no second agent runtime and no second model loop.

foxnio-side state is limited to control-plane records OMP does not own:
tickets, approvals, audit entries, and learned preferences. It never stores
session transcripts, project registry entries, credentials, or model
configuration. Project and session identity are references resolved through
the existing project registry and session reader.

The scheduler may only call existing RPC/session operations and existing
file/Git APIs. It must not add a browser-triggered host execution path.
```

## Rollout

1. Phase A: read-only, available without a setting.
2. Phase B: `chief.enabled` default off; start in `suggest`.
3. No migration; the new store is created on first enable.

## Testing

Phase A:

- `lib/briefing.test.mjs`: empty, one project, many projects, `input` dedupe
  (live pending + unread notification = one row), error ordering, activity
  ordering, `days` bounds, partial source warnings.
- A default install with notifications disabled still shows live input.
- `components/BriefingDialog.test.mjs`: empty, full, phone layout, refresh.
- Route: response shape and auth/origin behavior, reusing existing patterns.

Phase B:

- Fake clock: tick, quiet hours, daily budget, coalescing.
- Service-level idempotence: the same event twice creates one ticket without
  running the model.
- Broker autonomy: `observe` denies writes, `suggest` stores a proposal with
  no project writes, `approve` stores an action descriptor, `auto` applies the
  policy.
- Approval executes the stored descriptor through the broker; a model re-send
  is ignored.
- Chief tool set contains no `bash`, `write`, `edit`, `task`, `eval`, or
  `debug`; an unexpected OMP UI request is denied and audited.
- Host tool malformed arguments are rejected without a partial write.
- Loop detection: three failures → blocked plus one notification.
- Restart: pending wakes survive; no duplicate messages.
- Kill switch: no wake after disable.

## Decisions recorded

1. Briefing is a dialog first; promote it to a persistent view only if it is
   used daily.
2. Include Git dirty/branch in v1 for the 10 most recently active projects,
   loaded lazily.
3. One Chief for all projects, plus ordinary worker sessions per ticket.
4. Default autonomy is `suggest`; new projects start at `observe`.
5. `recent` is session activity, not a completion log. Completion stays in
   the session and notification surfaces.
6. Phase A is available without a setting. Phase B is `chief.enabled=false`
   by default.
