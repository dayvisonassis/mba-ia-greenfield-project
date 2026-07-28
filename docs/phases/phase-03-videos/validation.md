---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-27T20:41:30Z"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-27T20:37:45Z"
issues:
  - id: IC-1
    status: resolved
    summary: "All 10 current-scope TDs carry Libraries: — while TD-01 prose names @nestjs/bullmq 11"
    resolved_by: phase-03-videos/TD-01
  - id: IC-2
    status: resolved
    summary: "ffmpeg only in worker image vs no-mocking policy for the API test suite"
    resolved_by: phase-03-videos/TD-04
  - id: IC-3
    status: resolved
    summary: "Committed openapi.json is a maintained artifact but no phase step regenerates it"
    resolved_by: openapi-docs-nestjs/TD-02
  - id: IC-4
    status: resolved
    summary: "Thumbnail bucket serves anonymous users while TD-07 bars anonymous access to draft content"
    resolved_by: phase-03-videos/TD-02
  - id: IC-5
    status: resolved
    summary: "TD-02 fixes the object key as source.mp4 while TD-09 also accepts video/webm"
    resolved_by: phase-03-videos/TD-02
  - id: IC-6
    status: resolved
    summary: "TD-10 prose lists 'aplicar lifecycle' as a server operation after TD-03 dropped that mechanism"
    resolved_by: phase-03-videos/TD-10
  - id: MD-1
    status: resolved
    summary: "No TD decides accepted input policy (container/codec/mime) nor where it is validated"
    resolved_by: phase-03-videos/TD-09
  - id: MD-2
    status: resolved
    summary: "No TD names the S3/MinIO client library required by TD-02, TD-03 and TD-07"
    resolved_by: phase-03-videos/TD-10
  - id: AMB-1
    status: resolved
    summary: "'rascunho' undefined: processing status or publication visibility; exit transition"
    resolved_by: phase-03-videos/TD-08
  - id: AMB-2
    status: resolved
    summary: "'Download do vídeo pelo usuário' — owner only or any viewer/anonymous"
    resolved_by: phase-03-videos/TD-07
  - id: AMB-3
    status: resolved
    summary: "'extração de duração e metadados' — which metadata fields are persisted"
    resolved_by: phase-03-videos/TD-05
  - id: AMB-4
    status: resolved
    summary: "TD-03 revision fixes the sweep mechanism but not where it runs, how often, or the age threshold"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-1
    status: resolved
    summary: "TD-09 pending — política de inputs aceitos e onde ela é validada"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-2
    status: resolved
    summary: "TD-10 pending — cliente S3 para Node (presign de parte, presign GET, lifecycle)"
    resolved_by: phase-03-videos/TD-10
---

# phase-03-videos — Validation

## Findings

All fourteen issues raised across the four validate cycles are resolved. This pass re-ran every applicable check against the post-resolve `context.md` — it did not assume the prior verdict.

### Inconsistencies

_None._ IC-6 is closed by the revision on TD-10 that substitutes the abandoned-multipart sweep (`ListMultipartUploads` + `AbortMultipartUpload`) for `aplicar lifecycle` in the internal-endpoint enumeration and marks the heading's `e lifecycle rule` superseded; TD-10's `**Decision:**` is untouched, since both operations belong to the AWS SDK client it already chose. The five earlier `IC-N` remain closed.

Re-checked this pass: no capability bullet requires behavior a decided TD denies; no pair of decided TDs implies mutually exclusive runtime behavior; every `Capability:` field cites a bullet present in `## Scope`. The Scope-Subsection orphan check does not fire — all ten TDs carry `Scope: Backend`, so there is no `Scope: Frontend` TD to be orphaned by the absent UI Inventory.

_Note on the event-log model, now covering two TDs:_ the `**Recommendation:**` prose of both TD-03 and TD-10 still contains the word `lifecycle` — TD-03 still calls the rule obligatory, TD-10 still lists it among the internal endpoint's operations. Neither is an inconsistency **because each now carries a `**Revisions:**` block directly beneath it** correcting exactly that prose, and `/plan-build` consumes the per-TD block in `Recommendation → Libraries → Revisions` order. This is precisely what IC-6 fixed: before the resolve, TD-10 had stale prose with *no* revision below it, so nothing corrected the reader. The one remaining `lifecycle` match in the file is `guard lifecycle` inside the inherited `phase-02-auth/TD-08` (`@nestjs/throttler`) — a substring collision with no relation to object storage.

### Ambiguities

_None._ AMB-4 is closed by the second revision on TD-03, which fixes the three execution parameters the first revision left open: the sweep runs in the **`video-worker`** container of TD-04, **hourly**, and aborts only multipart uploads whose initiation is **at least 24 hours old**. The 24-hour threshold restates the `DaysAfterInitiation: 1` the superseded lifecycle rule already carried, so it reinstates the original decision's own value rather than introducing a new requirement.

_Checked and deliberately not raised:_ the revision names the cadence ("hourly") without naming the scheduling vehicle. That is derivable rather than ambiguous — TD-01 chose BullMQ specifically so that scheduling and retry become configuration rather than implementation, and BullMQ's repeatable-job facility is the vehicle already present in the phase. Raising it would invent an issue over a mechanism the stack decision already supplies.

The three earlier `AMB-N` remain closed by the revisions to TD-08, TD-07 and TD-05, and the two judgments recorded in prior passes are held unchanged: the thumbnail frame timestamp and output dimensions are implementation parameters, and the `visibility` value set is derivable from TD-08's and TD-07's revisions.

### Missing Decisions

_None._ Every bullet in `## Capability Coverage` maps to at least one decided TD (9 of 9, no `—` cells). The error-response format for the phase's new HTTP surface is covered by the inherited `phase-02-auth/TD-07`, so the first-HTTP-in-subproject sub-check does not fire. The shared-types contract-sync sub-type does not apply: `## UI Inventory` is absent (`ui_in_scope: false`), and that sub-type never fires without active UI scope.

### Dependency Gaps

_None._ Both prerequisites implied by `> Depende de: Fase 01, Fase 02` are inherited and present: the namespaced `registerAs` config foundation and the authenticated-user plus channel-ownership surface. The sweep added by TD-03's revisions introduces no new prerequisite — it runs in the `video-worker` container TD-04 already provisions, over the AWS SDK client TD-10 already decided, on the BullMQ instance TD-01 already chose. Within-phase ordering is implied by the TD dependency structure and remains `/plan-build`'s Dependency Map to formalize.

### Inherited Constraint Conflicts

_None._ The nine revision entries now applied across the three resolve cycles were each checked against the inherited material. The two added this cycle are compatible: TD-10's is purely lexical (it renames an operation in prose, touching no decision), and TD-03's places scheduled work inside the worker rather than the API — which *follows* the inherited separation of background work from the request path rather than straining it. The sweep moves no video byte, so the constraint that the API never handles the file is untouched. The revision appended to the inherited `openapi-docs-nestjs/TD-02` creates an obligation for this phase — regenerate and commit the spec — not a contradiction.

### Unresolved Open Questions

_None._ All ten current-scope TDs are `decided`; no `pending` rows remain in `## Decisions Index`. Both prior `OQ-N` were closed in earlier cycles. There is no `### Open Questions from Inventory` block to ingest — `## UI Inventory` is absent for this phase.

### UI Coverage Gaps

_None._ Check 7 is skipped entirely: `## UI Inventory` is absent, so `ui_in_scope: false` and UIG-N is not a concept for this phase. Phase 03 is backend-only by the challenge statement, and `next-frontend` is recorded as a deferred subproject in `## Scope`.

## Resolved Issues

- **IC-1** _(resolved_by phase-03-videos/TD-01)_ — All 10 current-scope TDs carried an empty `Libraries:` while TD-01's prose named `@nestjs/bullmq` 11.
- **IC-2** _(resolved_by phase-03-videos/TD-04)_ — ffmpeg was to be installed only in the worker image, colliding with the no-mocking policy for the API test suite.
- **IC-3** _(resolved_by openapi-docs-nestjs/TD-02)_ — The committed `openapi.json` is a maintained artifact but no phase step regenerated it.
- **IC-4** _(resolved_by phase-03-videos/TD-02)_ — The thumbnail bucket served anonymous users while TD-07 barred anonymous access to draft content.
- **IC-5** _(resolved_by phase-03-videos/TD-02)_ — TD-02 fixed the object key as `source.mp4` while TD-09 also accepts `video/webm`.
- **IC-6** _(resolved_by phase-03-videos/TD-10)_ — TD-10's prose and heading still named `lifecycle` after TD-03's revision dropped that mechanism. Closed by a `**Revisions:**` entry on TD-10 substituting the sweep in the internal-endpoint enumeration and marking the heading superseded; the `**Decision:**` is unchanged.
- **MD-1** _(resolved_by phase-03-videos/TD-09)_ — No TD decided the accepted input policy (container/codec/mime) nor where it is validated.
- **MD-2** _(resolved_by phase-03-videos/TD-10)_ — No TD named the S3/MinIO client library required by TD-02, TD-03 and TD-07.
- **AMB-1** _(resolved_by phase-03-videos/TD-08)_ — "rascunho" was undefined: processing status or publication visibility, and the exit transition.
- **AMB-2** _(resolved_by phase-03-videos/TD-07)_ — "Download do vídeo pelo usuário" did not say owner-only or any viewer/anonymous.
- **AMB-3** _(resolved_by phase-03-videos/TD-05)_ — "extração de duração e metadados" did not say which metadata fields are persisted.
- **AMB-4** _(resolved_by phase-03-videos/TD-03)_ — The sweep's mechanism was fixed but not its execution parameters. Closed by a second `**Revisions:**` entry on TD-03: `video-worker` container, hourly, 24-hour minimum age — the same threshold the superseded `DaysAfterInitiation: 1` carried.
- **OQ-1** _(resolved_by phase-03-videos/TD-09)_ — TD-09 was pending: política de inputs aceitos e onde ela é validada.
- **OQ-2** _(resolved_by phase-03-videos/TD-10)_ — TD-10 was pending: cliente S3 para Node (presign de parte, presign GET, lifecycle).
