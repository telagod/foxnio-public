# Unified foxnio data layer

Status: selected architecture; detailed design awaiting approval. No implementation yet.

## 1. Goal and approach

User asked to rewrite data flow/database for future expansion and selected the
recommended native facts + SQLite application database + unified read model.
Target remains one local installation serving multiple projects/browser tabs and
desktop. Do not add PostgreSQL, Redis, a message broker or a second agent runtime.

Alternatives: (A) keep filesystem/cache APIs and improve each separately (least
change, preserves inconsistent refresh/transaction contracts); (B) unified SQLite
worker with native-owned facts and replayable projection (selected); (C) take over
OMP storage/distributed services (violates current boundaries, unjustified).

Success: persistent lists and application metadata share versioned query/change
semantics; ordinary changes do not trigger repeated whole-transcript parsing;
reconnect cannot miss a change; concurrent application edits do not overwrite
unrelated changes; database work never blocks the HTTP/SSE event loop; migration
preserves user-owned data and cannot grant execution authority.

## 2. Ownership and migration inventory

| Source | Owner after change | Treatment |
| --- | --- | --- |
| OMP session JSONL, goal/todo, grant/revoke/reports, blobs, auth/provider databases | OMP | Never moved or directly rewritten; RPC/native mutation boundaries unchanged |
| projects.json (registry + presentation + launch configuration) | app.db application tables | One-time strict import, transactional commands, remove old writes |
| omp-web/session-ui.json pins | app.db application tables | One-time import; same pin ordering/cap semantics |
| omp-web/notifications.db history/read state | app.db application tables | Import history transactionally; retain old DB with retired VAPID/devices as historical backup; do not revive push APIs |
| FOX session.json pointer/reset epoch | app.db application tables | Transactional compare-and-set; native revoke still precedes reset |
| FOX service-state.json observation seen/day metadata | app.db application tables | Import durable seen/day metadata; runtime pending remains memory only |
| service.json dispatch/observation policy, omp-web-settings.json Agent tools/env | Existing operator/native file contracts | Keep single file authority; native extensions directly read these. API writes still use existing atomic file adapters; announce invalidations only after success |
| web-service.json/.env, auth secret, interrupted-session per-process recovery journals | Existing bootstrap/security/runtime contracts | Keep their lifecycle, permissions and process ownership; no generic key/value migration |
| Browser display prefs, drafts, tabs, unread/recent navigation cache | Browser | Retain device-local semantics; no server-side surprise synchronization |
| BRIEFING.md | Derived | Server updates it from read model; browser no longer writes the mirror |

No secret is copied into projection tables, change payloads or browser snapshots.
New app.db, -wal/-shm and backups are owner-only and denied by generic file APIs.
Native file authorization and FOX permission decisions NEVER use projection rows
as proof, even if a row claims grant=approved or cwd=allowed.

## 3. Storage architecture

`<getAgentDir()>/omp-web/app.db`, SQLite WAL. One Node worker per server process
owns its SQLite connections and all synchronous SQLite calls. Multiple foxnio
processes may share the installation: SQLite transactions serialize writes, and
revision reconciliation discovers changes made by another process. This is not a
claim of one global process/daemon or multiple-server agent execution ownership.

Use existing worker_threads/.mjs+jiti packaging pattern; no Bun SDK imports into
Node. Worker startup config binds exact canonical agent/session roots. Queue at
most 64 waiting requests, one running request; identical projection refreshes
coalesce. Admission overflow returns typed storage_busy. DB failures return typed
errors; never fallback to synchronous main-thread SQLite or old writable files.

Use WAL with busy_timeout bounded at 5000ms, foreign keys on, and synchronous=FULL
for app-owned metadata. Batched statements/one transaction for each command.
SQLite/open failures cannot initialize empty replacement state over damaged DB.

Schema namespaces (one file, separate ownership/rebuild rules):

- `schema_migrations`: versioned schema/import completion.
- `app_projects`: canonical path identity, addedAt/hidden/alias/order/pin/launchConfig.
- `app_session_pins`: session ID/time with existing200 limit.
- `app_notification_history`: current100 retained events/read state, unchanged tags.
- `app_fox_pointer`: single authoritative sessionId/resetAt/revokedSessionId plus version.
- `app_fox_observation`: durable seed/seen/day state, no pending task queue.
- `projection_sources`: source path+dev/ino/size/mtime/ctime/version/last-success/error.
- `projection_sessions`: SessionInfo fields, native parent/continuation/source identity.
- `projection_views`: versioned derived FOX briefing/goal display, never permission.
- `data_clock`: random database generation + monotonic committed revision.
- `data_changes`: bounded commit journal with revision/topic/keys or reset marker.

Exact physical split/SQL indexes follow actual queries, not a generic EAV store.
No persisted token stream or second transcript copy. Native transcript pages keep
the existing history worker and their entry-ID cursor. SQLite caches only metadata
and explicit display projections. Rebuilding projection_* cannot delete app_*.

## 4. Commands and consistency

Replace exported synchronous app-owned loaders/writers with async commands and
migrate EVERY caller; no sync shim, cached write authority or silently ignored
Promise. Native/operator file adapters remain synchronous where their CLI
contract requires it. One explicit exception at the synchronous RPC-frame
boundary is a bounded ordered notification write-behind queue: enqueue without
blocking token/tool frames, persist history and input-settlement together, then
fan out committed signals. Its failures are surfaced as storage degradation;
shutdown drains it with a deadline, and lost uncommitted work is not reported
as saved. Identity-pointer callbacks use tracked async CAS whose settlement is
awaited before dependent FOX actions, not a fire-and-forget unhandled write.

Application operations, not whole-state overwrite:

- upsert/hide/update project fields or batch reorder atomically;
- pin/unpin names, preserving untouched pins and timestamps;
- append notification + settle relevant pending input tags in one transaction;
- mark read/remove/clear specified history;
- FOX pointer CAS checks expected sessionId/resetAt/revokedSessionId inside the
  same transaction as mutation;
- observation state writes use expected version so concurrent observers cannot
  overwrite a newer saved state silently. A conflict requires reread/replan,
  never a blind retry of model execution.

Observation wake admission is claimed transactionally BEFORE the external RPC
effect. Store one bounded transport claim (wakeId, owner, lease, state) beside
observation metadata, not a task queue. A lease prevents competing claimants;
expiry alone never proves a wake did not execute. Confirmed pre-submit failures
release the claim; post-submit timeout/crash remains uncertain until native
session evidence for wakeId reconciles it. No automatic replay of an ambiguous
model turn, no exactly-once claim across SQLite and OMP. Daily/seen accounting
must distinguish reserved, delivered and uncertain wakes. Native runtime busy
is only local observation, never a cross-process claim.

Patch semantics preserve unrelated fields; a full replacement is only for the
one-time importer. Use expected row/domain version for user edits that depend on
a snapshot; reject stale destructive/replacement requests with409 conflict and
current version. Simple set/unset operations can be commutative and transactionally
applied without a global “everything changed” conflict.

Every actual DB change increments one revision and records changed topics/keys
in the SAME transaction. No-op commands do not increment. Publish only after
COMMIT. Native RPC operations retain accepted/running/uncertain meanings: a DB
revision is not an execution receipt and no two-resource transaction is claimed.

Secrets/operators files are not in the DB transaction; their adapter emits an
invalidation after atomic write, and startup/periodic source reconciliation
covers crash-before-invalidation. It does not claim atomic commit across JSONL,
filesystem and SQLite.

## 5. Native ingestion and session inventory

Move directory enumeration, file metadata scanning and per-file parse caches into
the storage worker. Reuse existing title-slot-aware scan semantics and preserve
SessionInfo shape, worktree grouping, native parent/path/ID forms and ordering.
Keep project-root resolution bounded and avoid import cycles through registry/
file-access/rpc-manager; isolate pure scan/normalization helpers where necessary.

Watcher events and native RPC invalidations feed ONE ingestion API. Known paths
refresh only their rows, unknown paths/root structure changes trigger inventory
reconciliation. Watcher lives for server lifetime, not only while browsers are
subscribed. Startup and periodic reconciliation recover missed/overflowed events;
manual refresh can require reconciliation. File stamps include dev,ino,size,mtime,
ctime. An explicit invalidation forces rescan even if stamps appear unchanged.
Never infer append-only from length or reuse offsets across a rewrite.

Scan each file with before/after version checks. A changing/inaccessible/malformed
file keeps its last known metadata plus stale/error status; it is not a tombstone.
Only a successfully completed directory inventory proves deletion. If a directory
scan fails, retain its rows and mark snapshot incomplete. A nonexistent sessions
root on a fresh install is a successful empty inventory, not a damaged DB.

Cross-process projection commits compare the observed base source version and
derived payload inside the write transaction. Duplicate reads may occur, but an
identical stamp/payload/health is a no-op and cannot increment revision twice.
A stale success or failure cannot overwrite a newer committed source version;
version conflict triggers reconciliation rather than last-writer-wins. Source
health changes also get revisions, but repeated identical failures do not.

Projection updates are atomic per completed ingestion batch. This guarantees a
consistent DB read, not an instantaneous atomic view of multiple external files.
Return source coverage and freshness so the distinction is visible. On a worker
crash, next request can recreate worker and replay persisted state; admitted write
completion may be unknown and must be reconciled, not transparently repeated.

Keep `resolveSessionPath`, existence/realpath checks, strict goal journal and
file-reference validation authoritative. Index rows are candidates for locating
native files; missing/mismatched files cannot cause `omp --resume` to create a
replacement silently. A read-model query never starts an OMP/model process.

## 6. Snapshot/revision/cursor protocol

Add one durable-data channel to the existing multiplexed SSE transport; keep
running/session streaming/host-tools/file channels and live epoch/sequence intact.

Cursor = `{generation,revision}`. Generation changes on creation/rebuild that
invalidates cursor history, never wraps revisions. Snapshot contains:
`{cursor,complete,staleSources,warnings,data}`. Snapshot data and cursor come
from the same SQLite read transaction.

The durable snapshot is the complete current session/project/pin/history/pointer
inventory, not a seven-day briefing. `days`, `now` and `excludeSession` are pure
aggregation parameters over that inventory. Native body/media history remains
paged separately; large metadata snapshots use bounded page transport pinned to
one read revision or restart if that revision cannot be retained. Never combine
pages from different revisions. Snapshot excludes live running/pending flags.

For paging, the worker owns at most four read-only snapshot connections. Each
opens a read transaction, reads data_clock to establish its snapshot, and serves
up to500 session rows/page under an opaque token with30s expiry. Small domain
tables belong to that same snapshot. Close on completion, cancellation, timeout
or worker exit; capacity exhaustion returns storage_busy. Expired tokens return
reset_required; the client never publishes partial replacement pages. WAL lets
the primary write connection continue while these bounded snapshots exist.
Readers are query_only and independent (no shared-cache). Release them in
abort-aware finally blocks and explicit completion/cancel requests; TTL is the
fallback, not normal cleanup. Periodic checkpoint is PASSIVE, never a blocking
FULL/TRUNCATE while readers are pinned. WAL growth during long readers remains
possible: journal_size_limit is not a hard active-WAL size cap. Handle disk-full
as a real write failure, and expire bounded snapshots rather than truncate data.
Projection rebuild invalidates snapshot tokens before any schema-changing work;
prefer transactional DELETE/INSERT over DROP/CREATE. Migration/exclusive backup
maintenance drains readers before operations requiring stronger locks.

Do not turn a full native inventory scan into a monolithic worker command that
starves pointer/control reads. Reconciliation processes bounded file batches,
coalesces pending dirty paths and yields between batches; application commands
have admission priority. Publish partial index batches with complete=false until
the successful final inventory phase; only that phase may apply proven deletions.

Changes endpoint returns committed batches newer than cursor, ordered and paged,
with an upper-bound cursor fixed for that page sequence. Retain newest10000
change revisions; max256 revisions/page. A missing/wrong-generation/future/
expired cursor returns explicit reset_required, not an empty successful delta.
A rebuild advances generation or emits a global reset; client must discard old
cursor, not its last visible data until replacement is ready.

SSE is a wake hint, not durable transport. Subscribe first, receive current head,
then query snapshot/changes. Client compares snapshot cursor with observed head;
if changes happened during the HTTP read, it catches up before claiming freshness.
After reconnect, use last applied cursor. Duplicate/old revisions do not overwrite
newer state. Gap/overflow forces reset. Another server process's commits are
observed via bounded head checks even without a local in-memory publish event.

Changes carry only `{revision,topic,keys,reset}`; no domain snapshots, launch
arguments, titles, notification details or transcript content. A client uses
these hints to fetch a complete consistent snapshot whose revision dominates
the observed head. Bounded coalescing prevents one request per token/event.
Slow subscribers receive reset rather than unbounded buffering. Failed fetches
retain last data and cursor with an explicit error.

A known head ahead of the applied cursor is an outstanding obligation: failed
HTTP catch-up retries with bounded1s→30s backoff until caught up, offline or
released; reconnect/foreground/new head triggers an immediate coalesced retry.
No timer runs when caught up. Initial snapshot failure follows the same rule.
The durable SSE opener opens promptly even during storage_busy/migration errors,
sends typed unavailable status and later head/reset; transient storage failure
must not permanently discard the subscription in SharedWorker transport.

## 7. Runtime state and FOX projections

Runtime state (running, pending ask, partial output) remains owned by live RPC.
Never write every token to SQLite. UI overlays runtime state using existing
`streamId/sequence`; durable revision and live sequence are separate clocks.
A reconnect seeds native live state independently of the data snapshot.

Session list/projects/pins/notification history APIs read the same DB service.
Only transcript-derived report/goal display facts are cached/persisted with
input source stamps and projection versions. Live running, pendingInput,
lastRunError and any `needsYou` value derived from them are NEVER persisted as
durable state or keyed solely by DB revision. Briefing recomputes that overlay
from current RPC on each read; a live-only change invalidates its frontend view
through the existing running/session channels without inventing a durable change.
FOX controls/dispatch continue calling strict native goal/journal code, never a
display cache. Source failure retains old display plus explicit stale status.

Frontend reuses the existing shared session store and adds one shared durable
subscription/cache. useBriefing/useFoxGoal/useSessionSignals and FoxPage's FOX
pointer checks consume it; remove their durable15s/60s/10s poll loops and browser
BRIEFING POST mirroring. Topics explicitly include sessions/projects/pins/
notification-history/fox-pointer/fox-observation/fox-display. Existing live
session healing and service-health polling remain live-only mechanisms, not
additional durable sources. Foreground/reconnect/manual refresh and outstanding
catch-up retry recover errors. Filtered views share inventory snapshots.

## 8. Migration, backup and failure

Fresh installs with no legacy app-owned sources initialize automatically. If
legacy sources exist and no committed migration marker exists, ordinary server
startup exposes typed migration_required rather than online-importing under an
unknown old writer. Provide `foxnio data migrate --offline`: operator must stop
all old foxnio instances; the flag is an explicit offline assertion, not a claim
that PID probing proves no writer exists. Refuse detectable live old instances.
The old recovery PID file is optional/deleted while idle, so its absence is not
proof of an offline installation.

Migration runs inside the worker/CLI storage engine under SQLite transaction
locking. Strictly validate all selected sources before one import commit. If
any required source is malformed, abort the complete cutover; preserving one
consistent authority is preferred to a half-migrated installation. Keep the
server shell/diagnostics available but dependent data routes return503
migration_failed with the source and recovery action. No empty/default fallback,
no write to source and no model execution depending on unavailable metadata.
Individually invalid optional fields may follow existing sanitization only with
explicit warnings. Retry the offline command after the operator repairs input.

Strict import matrix: absent source = empty domain; corrupt projects/pins/FOX
pointer (including reset epoch)/notification history DB = whole cutover failure.
Use strict importers, not existing display readers that swallow errors into
empty state. Invalid optional alias/order fields may be omitted with warning;
invalid launch configuration is execution-relevant and fails import, never
silently becomes a different command. Observation state with unknown/corrupt
schema also fails by default: resetting daily/seen metadata can produce extra
wakes. An operator may explicitly discard ONLY that derived observation domain
with a migration option, recorded as a warning; no silent budget reset.

Parse and validate external legacy sources before BEGIN IMMEDIATE, then recheck
their versions before inserting. The transaction contains only SQL import and
the completion marker, not filesystem traversal/parsing. Migration holds an
exclusive offline maintenance guard against new-version writers; source changes
abort rather than mix versions. Existing app.db migrations require a supported
schema and never replace populated application tables with a legacy reimport.

Storage readiness gates ingestion watchers, FOX service/observation and BRIEFING
materialization. They do not seed defaults or wake models during migration_required
or migration_failed. Read APIs propagate the typed storage error; the frontend
keeps prior data and shows migration instructions. Health/diagnostic routes and
the shell remain reachable. Migration failure is not an empty portfolio.

The migration CLI and backup commands are local operator actions, not a browser
filesystem/restore API. Use Node24's verified node:sqlite DatabaseSync and backup
API in the worker/CLI engine. Known credential stores, agentEnv and retired VAPID
keys are excluded. Free-text session summaries/project launch arguments may
contain user-provided sensitive text: retain existing authenticated visibility,
do not claim automatic anonymization, and never place these values in change
notifications. Those carry only topic/keys/revision.

Read legacy notifications.db through SQLite read-only so uncheckpointed WAL data
is not lost by copying the main file. Import only live history/read state; retain
old VAPID/devices on disk as history. Existing notifications.json import may be
used only if DB absent, with existing secrets kept out of app projections.

Record import completion in the same transaction as imported rows. Crash before
commit leaves old authority; crash after commit uses DB even if backups were not
renamed. On success old sources are retained as versioned/read-only migration
backups and no longer written/read as live state. Never dual-write. Refuse a
newer unsupported schema rather than downgrading. Startup migrations must not
race an old foxnio process still writing the old files: deploy with old instances
stopped; identify/refuse known active old writers rather than pretending an
online cross-version migration is safe. Same-version processes serialize via DB.

Protect against DB loss after migration: keep deterministic protected backup
names and an owner-only `app.db.migration-receipt.json` outside SQLite containing
database installation identity, schema version and imported source digests.
Write the receipt after commit and before retiring any source. On restart,
committed DB can finish a missing receipt/backup step idempotently. If DB is
missing but receipt/backups prove prior initialization, return restore_required;
never create an empty replacement or automatically reimport old backups.
Receipt is a migration/recovery guard, not another mutable app-state authority.
Initial fresh creation also writes it so later DB deletion cannot look fresh.

Backups use SQLite consistent backup/checkpoint semantics, not live file copying.
Export includes schema/version and app-owned metadata; rebuilding caches is a
different operation from restoring user data. Any restore/rollback that discards
new DB writes requires explicit user consent. No automatic destructive rollback.
All automatic backups/exports/temp copies stay in the protected agent app-data
directory, use an `app.db` prefix and mode0600; preserved legacy backups retain
their denied basename prefixes. Add project-registry backups to file denial as
well, since launch args may contain sensitive user text. The CLI does not export
arbitrary paths by default. Retained notifications DB is opened read-only in place;
do not rename its main file away from live -wal/-shm files. Keeping the old name
as a documented read-only backup is preferable to a broken renamed backup.

## 9. Acceptance

1. Legacy fixtures migrate once including project launch config/pins/unread,
   repeat startup is identical, malformed input and injected transaction failure
   do not lose or partially promote user data. Old files no longer receive writes.
2. Two independent worker connections concurrently patch distinct project fields,
   pin/unpin and pointer CAS without lost updates; stale CAS returns409.
3. Killing the worker during a write produces a recoverable/uncertain outcome,
   never false success. Rebuilding projections leaves app metadata unchanged.
4. Native add/rename/delete/rewrite/same-size change/fork/continuation updates
   correct rows; unreadable/changing sources preserve visible data as stale.
5. Browser disconnected between snapshot and subscribe, stale cursor, out-of-order
   response, journal pruning and another server's commit all converge without
   cursor advancement on failed reads.
6. Streaming tokens/host tools stay live during index scans and busy SQLite.
   Prove unchanged list requests do not reparse unchanged session bodies.
7. Native permission checks still refuse missing paths, symlink escapes, revoked
   grants and invalid lineage even if the display index contains an older row.
8. Real browser sidebar/FOX/pins/history converge after mutation and reconnect on
   desktop/mobile; no independent polling or browser-owned BRIEFING mirror remains.
9. Installed/package worker bootstrap works under Node24 and desktop packaging;
   shutdown releases workers/DB; no credential leakage via APIs/change payloads.
10. Existing native goal execution and manual FOX acceptance still run against
    isolated OMP without a second runtime or permission store.

## 10. Implementation boundaries

This changes storage, server adapters, ingestion/sync protocol and frontend
consumers together. Internal implementation tasks may run in parallel with fixed
interfaces; switch one domain fully, delete its obsolete live writers/caches, and
integrate before enabling production. No product code before design approval.
Do not claim completion for just a new database module or revision field.

Operator/native files retained in §2 are intentional compatibility boundaries,
not unfinished migration. Multi-host multi-user synchronization is not introduced;
the typed command/query/event boundaries leave room for a later intentional
architecture change instead of coupling every feature to a filesystem layout.
