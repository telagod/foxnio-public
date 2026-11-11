# Unified Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development. Implement only owned files; do not run build/lint/tests/formatters mid-flight. Parent runs integrated verification after the wave.

**Goal:** Replace scattered application persistence and persistent-data refresh with one SQLite worker and revisioned snapshots, preserving native execution authority.

**Architecture:** app.db owns foxnio metadata and rebuildable native display indexes. A bounded worker owns SQLite and file ingestion; command results/revisions are transactional. One browser durable store follows replayable changes, while live RPC remains a separate stream.

**Tech Stack:** Node24 node:sqlite + worker_threads, plain .mjs bootstrap/jiti, Next/TypeScript, existing multiplexed SSE/React stores.

**Spec:** docs/specs/2026-11-11-unified-data-layer-design.md (explicitly approved by user).

## Global constraints

- Worktree `/home/telagod/project/foxnio/fox-data`, base405f2a52. Never alter `ompweb` production checkout/data/service.
- No OMP DB/JSONL writes, no cached grant authority, no second scheduler/runtime, no global settings changes.
- Migrate projects/pins/notification history/FOX pointer/observation state. Retain native/operator `service.json`, `omp-web-settings.json`, bootstrap/auth/interrupted-session contracts and browser-local prefs.
- SQLite WAL synchronous FULL; busy timeout5000; one worker per process/root context; max64 waiting jobs. No main-thread SQLite.
- Changes retain10000 revisions, page max256, topic/keys only. Cursor generation+revision.
- Snapshot read pool max4, TTL30s, page500 sessions; query_only/readOnly and PASSIVE checkpoint. No mixed-revision pages.
- Existing legacy sources require explicit offline migrate. Receipt guard BEFORE legacy detection; missing DB+prior receipt/backups → restore_required. Strict entire import transaction; source parse outside write lock; no dual writes.
- Tests exercise real data boundaries, no source-text/incidental wording checks. LSP references attempted and unavailable; exact grep fallback allowed. No child commits/subagents. Parent verifies and reviews integrated wave.

## Shared contracts (exact module/API names)

### Storage protocol and client (StorageCore owner)

`lib/storage/protocol.ts` exports:
- `DataCursor { generation:string; revision:number }`.
- `DataTopic = 'sessions'|'projects'|'pins'|'notification-history'|'fox-pointer'|'fox-observation'|'fox-display'|'operator-settings'`.
- `DataChange { revision:number; topic:DataTopic; keys:string[]; reset?:boolean }`.
- `DataHealth { complete:boolean; staleSources:string[]; warnings:string[] }`.
- `DataSnapshot { cursor:DataCursor; complete:boolean; staleSources:string[]; warnings:string[]; data:{sessions:SessionInfo[]; projects:ProjectRegistryEntry[]; pins:PinnedSession[]; notifications:NotificationHistoryEntry[]; foxPointer:FoxSessionRecord; foxObservation:FoxServiceState} }`.
- `StorageRoots { agentDir:string; sessionsDir:string; foxDir:string }`; default roots from getAgentDir/getSessionsDir/foxWorkspaceDir, optional injected roots for isolated tests/legacy home overloads.
- `StorageError extends Error {code:string; outcome?:'not_committed'|'uncertain'}` codes storage_busy/storage_unavailable/storage_conflict/migration_required/migration_failed/restore_required/reset_required/schema_unsupported.
- Typed `StorageRequest` discriminated by `operation` with query/command ops below and mapped `StorageResults`. No unvalidated arbitrary SQL in RPC.

`lib/storage/client.ts` exports `storageRequest(request,roots?):Promise<result>`, `storageRoots(home?):StorageRoots`, `closeStorage():Promise<void>`, `subscribeStorageChanges(listener:(cursor:DataCursor)=>void):()=>void`. Client serializes worker requests, retries only safe queries on next call, never an admitted mutation automatically. Callback signals post-COMMIT; subscription includes cross-process head checks at most once/second while subscribers exist.

Operations:
- `status` → `{ready:boolean,cursor?:DataCursor,error?:{code,message}}` (must not falsely auto-init migrated/malformed state).
- `head` → DataCursor.
- `snapshot.open` → `{token:string,cursor,complete,staleSources,warnings,data:DataSnapshot['data'],next:boolean}` first500 sessions; small domains from same pinned readtxn.
- `snapshot.page {token}` → `{cursor,sessions:SessionInfo[],next:boolean}`; `snapshot.close {token}` → void.
- `changes {cursor,through?:DataCursor,limit?:number}` → `{cursor:DataCursor,through:DataCursor,changes:DataChange[],hasMore:boolean}` or reset_required.
- `projects.get` → `{version:1,projects:ProjectRegistryEntry[]}`.
- `projects.patch {updates:Array<{path:string,register?:boolean,addedAt?:string,hidden?:boolean,alias?:string|null,sortOrder?:number|null,pinOrder?:number|null,launchConfig?:ProjectLaunchConfig|null}>,expectedRevision?:number}` → registry; only supplied fields change, atomic batch.
- `pins.get` → `{pinned:PinnedSession[]}`; `pins.patch {pin?:string[],unpin?:string[],now?:number}` → same.
- `notifications.list` → NotificationHistoryEntry[]; `notifications.record {event,at?:number,read?:boolean,settleInputIds?:string[]}` → entry (record+settlement one transaction); `notifications.read {ids:string[]}` / `.remove {id}` / `.clear` → void.
- `foxPointer.get` → FoxSessionRecord; `foxPointer.cas {expected:FoxSessionRecord,next:FoxSessionRecord}` → FoxSessionRecord|null; `foxPointer.reset {expected?:FoxSessionRecord}` → record (CAS when expected supplied).
- `foxObservation.get` → `{state:FoxServiceState,version:number}`; `.save {state,expectedVersion:number}` → versioned result or storage_conflict. Pending retry not persisted.
- `observation.claim {expectedVersion:number,wakeId:string,eventKeys:string[],owner:string,now:number,leaseMs:number}` → `{claimed:boolean,version:number}`; `.settle {wakeId,owner,outcome:'delivered'|'not-submitted'|'uncertain',state?:FoxServiceState}` → versioned state. Pending/uncertain claim surfaced by `.get` optional transport field; no automatic replay of unknown effect.
- `index.get {ids?:string[]}` → `{sessions:SessionInfo[],missing:string[],cursor,complete,staleSources,warnings}`.
- `index.apply {updates:IndexedSource[],removedPaths?:string[],health?:DataHealth,expectedSources?:Record<string,string|null>}` → cursor; only actual row/health changes revise; stale base rejects conflict.
- `index.sources` → `{sources:Array<{path,stamp:string,payload?:SessionInfo,error?:string}>}`.
- `index.rebuild` invalidates readtokens+clears projection only+new generation, app tables preserved.
- `views.get {key:string,sourceVersion:string}` → `{value:unknown}|null`; `views.put {key,sourceVersion,value}` → cursor; display only, no live fields.
- `invalidate {topic:DataTopic,keys:string[]}` → cursor (for externally written operator/native facts; coalesce duplicates through stamps where known).
- `migrate {offline:true,discardObservation?:boolean}` → `{cursor,warnings:string[],alreadyMigrated:boolean}`; only CLI/isolated tests use.
- `backup` → `{path:string,cursor:DataCursor}` protected app.db-prefixed destination owned by engine. No browser backup endpoint.

`IndexedSource {path:string;stamp:string;session?:SessionInfo;error?:string}`. NativeIndex owner supplies all SessionInfo grouping; storage never reads OMP secret DBs. A field not known in plan must be agreed with consumers before editing, not guessed.

### Native index/ingestion (NativeIndex owner)

`lib/session-index.ts` exports:
- `ensureSessionIndex({force?:boolean}={}):Promise<void>` initial scan once; full/dirty invalidations coalesce.
- `invalidateSessionIndex(paths?:readonly string[]):void` records dirtiness, schedules worker ingestion without blocking synchronous RPC frames.
- `readSessionIndex(ids?:readonly string[]):Promise<StorageResults['index.get']>` awaits first ready scan, then queries latest committed projection (stale flags visible).
- `startSessionIndex():Promise<()=>void>` server-lifetime watcher + periodic60s reconciliation; startup behind storage ready. `stopSessionIndex():Promise<void>` cleanup.
- `readDurableSnapshot():Promise<DataSnapshot>` combines snapshot pages atomically, closes token in finally.

`lib/storage/native-index.ts` owned NativeIndex, worker-only exports `scanNativeIndexBatch(request,roots,registeredProjects):Promise<NativeScanResult>`. Core adds `index.scan` worker op delegating to this module. Request `{paths?:string[],scanToken?:string,force?:boolean}`, response `{updates:IndexedSource[],removedPaths?:string[],nextScanToken?:string,complete:boolean,staleSources:string[],warnings:string[]}`. Directory inventory/stamps tracked within bounded worker job; batches max64 files, source errors retain rows. Core worker must allow app ops between batches. Main reconciler submits batches sequentially via storageRequest; engine applies each with source compare-and-set, final complete inventory proves deletions.

Refactor project-root/worktree resolution into pure worker-safe helper where necessary; no worker import cycle into registry client/file-access/rpc-manager. Preserve existing canonical paths/worktree behavior and SessionInfo shape. Parent inherits strict native authority paths unchanged.

### Sync HTTP/events (DataFrontend owner)

`GET /api/data/snapshot[?token=...]` wraps snapshot.open/page (no native live data), DELETE same endpoint with token closes snapshot. `GET /api/data/changes?cursor=<JSON>&through=<JSON>` wraps changes; invalid requests400, reset_required409, storage/migration503.
New SSE channel `{kind:'data'}` emits `{type:'data-head',cursor}` or `{type:'data-unavailable',code,message}`. It opens immediately; worker availability never destroys subscription. Hints may coalesce to latesthead; no secret payload.
`lib/data-store.ts` shared browser store; exports `getDataStore()` with `retain/release/getSnapshot/subscribe/refresh`; state `{snapshot:DataSnapshot|null,status:'loading'|'ready'|'error',error:string|null}`. Catch up by coalesced consistent snapshot after reading changeheads (keys only); maintain appliedcursor until fullsnapshotpublishes, stale responses dropped, generationresethandled. Knownhead-aheadfailedfetch retries1→30s, caughtup no timer.

Frontend existing session-store consumes data-store sessions/projects/pins, keeps runtime running/optimistic/unread/recent transitions. Backend API shape legacy directqueries may remain for nonbrowser callers but use sameworker; no oldsourcefallback.
`useBriefing/useFoxGoal/useSessionSignals/FoxPage pointer` subscribe to durable topics + actual live signals, not durable perhookpoll. UseBriefing no longer POSTs BRIEFING.md. Live servicehealth polling remains. Data unavailable does not clear priorarrays.

### Application adapters/integration (AppDomains owner)

`project-registry.ts` retains pure parsers/upsert/presentation helpers, `loadProjectRegistry():Promise<registry>` queries storage. Replace saveProjectRegistry whole-state API with `patchProjectRegistry(updates,expectedRevision?)` using projects.patch. No lost-update RMW. Migrate every production+test caller.
`session-ui-state.ts` async reads/commands via pins ops.
Delete `notification-store.ts` and obsolete device/VAPID exports/tests; add `notification-history-store.ts` async functions named listHistory/recordHistory/markHistoryRead/removeHistory/clearHistory. Native RPC notification ingress uses ordered bounded writebehind commit→signal, no block on stream. Parent owns hub/rpc adoption (below).
`fox-session.ts` same exported names but Promise return, CAS insideworker. home overload maps isolated StorageRoots consistently. Reset native revoke before pointer CAS.
`fox-service-state.ts` read/write versioned worker APIs, migration importer uses new strict parse not display fallback. `fox-service-engine` awaits depsload/save and claimbeforewake, outcomes explicit. Nativewake carrieswakeId, unknown effects not retried.

## Task 1: SQLite engine, worker and offline migration (StorageCore)

**Own:** lib/storage/{protocol.ts,client.ts,engine.ts,schema.ts,migration.ts,worker.mjs}, storage-focusedtests; bin/omp-web-data.mjs (new), bin/omp-web.js data subcommand routing. Do not edit native-index.ts or other owners' modules.

- [ ] Write transaction/migration/cursor tests: no loss on failure, dbmissing+receipt refusesinit, two connections disjointpatch/CAS, WALhistory import, reset/prunedcursor, snapshot pages pinnedrevision, queueoverload/crashunknown, projectionrebuildpreservesappdata.
- [ ] Implement schema/typed operations/workerqueue/crossprocesshead/snapshotpool/consistentbackup; localSQLiteallworkeronly.
- [ ] Strict migrate from actuallegacyformats with metadata digest/guard/receipt/retainedbackups. DeadnotificationsVAPID staysoldDB; no falseempty.
- [ ] CLI `foxnio data status|migrate --offline [--discard-observation]|backup|rebuild-index`; backup protected destination; do not auto migrate user's live installation.
- [ ] Add delegation op index.scan to NativeIndex worker module; publishtypes/contracts promptly.

## Task 2: Native index and persistent session read cutover (NativeIndex)

**Own:** lib/storage/native-index.ts, lib/session-index.ts, lib/session-reader.ts, lib/omp/session-files.ts listingcache sections, lib/session-watcher.ts, lib/project-resolution.ts if extracted; corresponding sessionreader/scanner/index tests. Do not edit worktree.ts (AppDomains owns; coordinate pure resolver interface).

- [ ] Write equivalence/changedfile/deletion/inaccessible/samestamp/fork/worktree tests, plus eventloopresponsiveness smoke.
- [ ] Worker scan boundedversions+directories, forceinvalidations, batchcoalescing, persistentprojection comparisons; no delete on failedinventory.
- [ ] Route listAllSessions/listSessionsByIds tostorageprojection and removeoldlist/scan/walkcacheownership. Strict resolveSessionPath checks sourceexists/header; cacheonlylocatescandidates.
- [ ] Ownserverlifetimewatcher, periodicreconcile independentbrowser; preserve sessiondetailhistoryworkerinvalidations and caller signatures.
- [ ] Durable snapshot helper readsallpagesunderonecursor and closesreader; no liveflags.

## Task 3: Async application-domain migration (AppDomains)

**Own:** lib/project-registry.ts, lib/worktree.ts, lib/session-ui-state.ts, lib/notification-history-store.ts/new, deleteoldnotification-store.ts; lib/fox-session.ts, lib/fox-service-state.ts, lib/fox-service-engine.ts/core only if claimoutcomesneeded; app/api/projects/route.ts, app/api/session-ui/route.ts, app/api/notifications/history/route.ts, app/api/fox/session/{route.ts,reset/route.ts}, app/api/fox/service/route.ts, app/api/advisor-default/route.ts ifcaller; domain tests. Parent owns rpc-manager/fox-service/briefing/goal-service callsites and notificationshub.

- [ ] Convert realproduction APIs async, transaction patches insteadwholeoverwrite; migrateallown tests toasyncbehavior and removeincidentalfilelayout assertions.
- [ ] FOXpointer CAS/reset transaction preserveepoch/currentgrants; observationCASclaimbeforewake with uncertainstate notautomaticreplay. Publish exactengine signatures toparent.
- [ ] Worktree/project-root resolution avoids worker cycle and remains correct; helperextractioncoordinateNativeIndex.
- [ ] Oldnotification-storedeleted fully, deadVAPID/devicepersistenceexportsremoved; historymigrationownedCore preservesoldbackup.

## Task 4: Durable revision API, shared frontend store and consumer cutover (DataFrontend)

**Own:** app/api/data/* new, lib/data-store.ts/new and tests, lib/event-stream-protocol.ts, lib/event-stream-hub.ts, public/event-stream-worker.js and needed lib/event-stream*.ts browsertransport, lib/session-store.ts/tests, hooks/useBriefing.ts/useFoxGoal.ts/useSessionSignals.ts +tests, components/FoxPage.tsx, lib/notification-history.ts/tests. No other UI cosmetics.

- [ ] Implementtypevalidatedsnapshot/changeHTTP+SSEhead, pinnedreaderabortcleanup, retryableserviceunavailable.
- [ ] Shared browsercache withgeneration/revision ordering, catchupretry/coalescing and no partialpublish; tests snapshot-subscribe-gap, delayedHTTP, oldresponse, pruning, offline/reconnectandfailurestabledata.
- [ ] Sessionstore consumesdurabledata, running channel retainslive; removeETag/id-delta persistentrefresh duplication. All callersremainbehaviorcompatible.
- [ ] Hooks/pointerconsume shared revisions, removepolls/browserBRIEFINGmirror. TriggerFOXLIVEderivedrefreshfromrunning/sessionevents evenwhenrevisionunchanged; keepservicehealthpoll.
- [ ] Input/historysignal processingpreservesactualpendingdialogs and goalnotices; historyreadstate comes DB snapshot.

## Task 5: Server integration, display projection and end-to-end proof (parent)

**Own:** lib/rpc-manager.ts, lib/fox-service.ts, lib/briefing-server.ts, lib/fox-goal-service.ts, lib/fox-goal-notifications.ts, lib/notification-hub.ts; app/api/sessions/route.ts, app/api/briefing/route.ts, retiredmirrorroute, instrumentation.node.ts; securityfiledenylist; docs/changelog/desktoppackaging and allremaining affectedcallsites/tests notownedabove.

- [ ] Awaitasyncappops including launchconfig/advisor/cwdresolution; identitycallbacktrackedCAS beforedependentcommands. Boundedorderednotificationingressqueue committhenfanout, no awaitblockonframe.
- [ ] Gateapplicationstartup onstorageready, exposemigration_required/failed UIerror withoutemptyportfolio; operatorfilechanges emit invalidations.
- [ ] Persist/cacheonlynative report/goal display sourceversions; briefings overlaycurrentlivealways. Strictgoalexecution neverprojection. ServerBRIEFINGwriter replacesbrowserPOST.
- [ ] Updateappdatafiledenylist/0600backup/protection and desktopruntimeassets.
- [ ] Realisolatedmigration smoke(two workerconnections, malformedsource, WALbackup, workercrash), browserreconnect+pindata+FOXviews, nativegoal/manualFOX regressions, typecheck/buildafterintegration.
- [ ] Independentstorage/securityandsync review,fixloadbearingfindings, updateDESIGN/CHANGELOGandoperatorinstructions aftersmoke. Do notmigrateproductiondata/deploywithoutuserapproval.

## Preflight and rulings

| Shared pair | Boundary | Decision |
| --- | --- | --- |
|1↔2|worker index.scan/native-index helpers|Core ownsengine; Index ownsworker scanner, exactprotocolabove|
|1↔3|domainrequests/asyncresults|Core actualSQL; Domains adapters/callers, no duplicatedliveSQL|
|1↔4|cursor/snapshotchange APIs|TypesinCore; Frontendconsumesfixedshapes|
|2↔3|worktreepureprojectresolution|Indexnewhelper, Domainsoldworktreecaller; communicatebeforeextract|
|3↔5|asyncFOXpointer/observation/history|Domains exportsPromise; parentawaitsallremainingservercallers|
|4↔5|displayrefresh/durablerevision/liveoverlay|No persistliveflags; serverpublishesprojectioninvalidations, frontendsharedcache|
|1|migrationerrorvsfreshinit|receiptguardfirst, sourceparseoutsideSQL, wholeimportcommit|
|2|cachevspermission|indexonlycandidates; strictnativechecksunchanged|
|3|notificationframeasync|soleboundedwritebehindexception; committhenfanout|
|4|no pollingvsrecovererrors|retryonlyoutstandinghead/unavailable, no caughtupinterval|
|5|multipleprocessobservation|claimbeforewake; expiredleaseisNOTpermissiontoreplayunknownsubmission|

Ruling: user approved detailed design and delegated ordinary decisions; no extra execution-method confirmation.
Ruling: no productdata migration/restart here. Worktree isolatesactive service.
Ruling: independentfileowners runconcurrently with fixedinterfaces perrepositorytoolpolicy; children skipchecks, parentverifiesintegratedwave.
