---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-27T02:13:56Z"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-27T02:10:44Z"
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

### Inconsistencies

_None._ The five prior `IC-N` are closed. Verified this pass: no capability bullet requires behavior a decided TD denies; no pair of decided TDs implies mutually exclusive runtime behavior — in particular the three couplings that produced the last two findings are now aligned (TD-02's thumbnail bucket is private in this phase, matching TD-07's owner-only gate; TD-02's object key is extension-less, matching TD-09's two-container allowlist; TD-05's persisted `format_name` is what now carries the container the key no longer encodes). Every `Capability:` field cites a bullet present in `## Scope`. The Scope-Subsection orphan check does not fire: all ten TDs carry `Scope: Backend` and no `Scope: Frontend` TD exists.

_Note on the event-log model:_ TD-02's `**Recommendation:**` prose still reads `{videoId}/source.mp4` and still frames the bucket split on anonymous thumbnail serving. That is **not** an inconsistency — `**Revisions:**` is the designed mechanism for parameter drift on an already-decided TD, and the two revision entries sit immediately below the prose as the current truth. Treating a revision as contradicting the prose it revises would make revisions structurally incapable of closing an issue. `/plan-build` consumes the per-TD block in `Recommendation → Libraries → Revisions` order, so the revision is read last.

### Ambiguities

_None._ The three prior `AMB-N` are closed by revisions to TD-08, TD-07 and TD-05. Two judgments are held unchanged from the prior three revisions, recorded here so they are decisions rather than omissions: **(1)** the thumbnail frame timestamp and output dimensions are implementation parameters `/plan-build` fixes from TD-05's tooling decision, not strategic choices; **(2)** the `visibility` column's value set is derivable from the two TDs that reference it — TD-08's revision fixes `draft` as the default and the only value this phase occupies, and TD-07's revision names `published` as the value the later phases gate on.

### Missing Decisions

_None._ Every bullet in `## Capability Coverage` maps to at least one decided TD (9 of 9, no `—` cells). The error-response format for the phase's new HTTP surface is covered by the inherited phase-02-auth/TD-07 (Custom Domain Exception Filter), so the first-HTTP-in-subproject sub-check does not fire. The shared-types contract-sync sub-type does not apply: `## UI Inventory` is absent (`ui_in_scope: false`) and that sub-type never fires without active UI scope.

_Checked and deliberately not raised:_ TD-02's revision states the thumbnail is served "pelo mesmo caminho da TD-07 (redirect para URL pré-assinada de `GET` + verificação de propriedade)", and no phase capability asks for thumbnail *delivery* — the bullet in scope is *"Geração automática de thumbnail a partir de um frame do vídeo"*, i.e. generation and storage. With `next-frontend/` deferred, nothing in this phase consumes the thumbnail, so there is no missing endpoint decision: the revision fixes the bucket's access property and names the gate that a later phase will reuse. Generation remains observably deliverable (the object exists in the bucket and is assertable in tests).

### Dependency Gaps

_None._ Phase 03 declares `> Depende de: Fase 01, Fase 02` and both implied prerequisites are inherited and present: the namespaced `registerAs` config foundation, which phase-01-configuracao-base/TD-03 explicitly anticipated for storage, and the authenticated-user plus channel ownership surface from Phase 02 — now load-bearing, since TD-07's revision depends on it for the ownership check and TD-02's revision routes thumbnail access through the same gate. Within-phase ordering is implied by the TD dependency structure (storage and queue before upload, upload before processing, processing before delivery) and is `/plan-build`'s Dependency Map to formalize.

### Inherited Constraint Conflicts

_None._ All seven revision entries applied across the two resolve cycles were checked against the inherited material and none departs from it: TD-07's ownership gate and TD-02's thumbnail routing *follow* the inherited global-`JwtAuthGuard`-with-`@Public()`-opt-out pattern rather than working around it; TD-08's new `visibility` column follows the inherited `synchronize: false` plus immutable-migrations regime; TD-01's Redis settings and TD-10's dual endpoint are new namespaced configs in the inherited `registerAs` style; TD-04's added FFmpeg install in the API/dev image is what brings the phase *into* compliance with the inherited external-systems testing policy. The revision appended to the inherited `openapi-docs-nestjs/TD-02` creates an obligation for this phase — regenerate and commit the spec — not a contradiction.

### Unresolved Open Questions

_None._ All 10 TDs in `## Decisions Index` are `decided`; no TD is `pending`, no open question carries forward, and the phase has no UI inventory contributing open questions.

### UI Coverage Gaps

_None._ `## UI Inventory` is absent (`ui_in_scope: false`) — `## Scope` records `**Deferred subprojects:** next-frontend/` with the video interface out of scope for this phase — so UI coverage is not a concept here.

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-09)_ — No TD decided the accepted-input policy (container/codec/mime allowlist, duration cap) nor where it is enforced, given that TD-03 sends the bytes straight from client to storage. Closed by the `/research` cycle that created TD-09, which frames the choice as *where* enforcement lives and eliminates the presigned-POST-conditions option as incompatible with TD-03's per-part multipart.
- **MD-2** _(resolved_by phase-03-videos/TD-10)_ — No TD named the S3/MinIO client required by TD-02 (bucket bootstrap), TD-03 (per-part presign plus the lifecycle rule that expires incomplete multipart) and TD-07 (presigned `GET`). Closed by the `/research` cycle that created TD-10, whose Options were verified against the libraries' own documentation via context7.
- **OQ-1** _(resolved_by phase-03-videos/TD-09)_ — TD-09 was `_[pending]_`. Decided **Option A** — declaração validada na iniciação + verificação real no worker. Parameters fixed in the TD: allowlist `video/mp4` + `video/webm`, worker checks `format_name` plus presence of a video stream, no duration cap, and a single shared constant imported by API and worker.
- **OQ-2** _(resolved_by phase-03-videos/TD-10)_ — TD-10 was `_[pending]_`. Decided **Option A** — `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`. `**Libraries:**` recorded on the TD and both packages cached in `library-refs.md` with the context7-confirmed API surface.
- **IC-1** _(resolved_by phase-03-videos/TD-01)_ — `Libraries: —` on every current-scope TD while the prose named concrete packages. Resolved as an **Append revision** to TD-01, which now records `bullmq, @nestjs/bullmq`; TD-10 carries the two AWS packages. `ffmpeg`/`ffprobe` were deliberately left out of the field — they are Dockerfile binaries, and feeding them to resolve's Step 5 would fire a registry lookup with no package to resolve, aborting the stage. `library-refs.md` was created with all four npm packages.
- **IC-2** _(resolved_by phase-03-videos/TD-04)_ — The external-systems policy ("do not mock what the Compose stack can run for real") collided with FFmpeg installed only in the worker image while the suite runs in `nestjs-api`. Resolved as an **Append revision** to TD-04: `ffmpeg`/`ffprobe` are now installed in the API/dev image **as well**, so integration tests spawn the real binary where the suite already runs. Option A of TD-04 is unchanged — the worker stays in its own container.
- **IC-3** _(resolved_by openapi-docs-nestjs/TD-02)_ — The committed `openapi.json` is a maintained, versioned artifact but no phase step regenerated it, so Phase 03's new HTTP surface would leave the spec describing an API that no longer exists. Resolved as an **Append revision** to `openapi-docs-nestjs/TD-02` establishing a standing rule: every phase that adds or changes an endpoint owns regenerating and committing the spec, with the explicit decorators TD-01's 2026-05-12 revision requires. Chosen over a phase-local obligation so Phases 04–07 inherit it.
- **IC-4** _(resolved_by phase-03-videos/TD-02)_ — TD-02's bucket split was justified on anonymous serving ("thumbnail é servida a usuários anônimos"), a premise that TD-07's owner-only revision invalidated for this phase; since the thumbnail is a frame of the video itself, a public bucket would hand anonymous users a frame of owner-only `draft` content. Resolved as an **Append revision** to TD-02: the thumbnail bucket is **private in this phase**, served through the same presigned-redirect + ownership path as TD-07, and flips to public in the phase that introduces publication (Fase 04). The two-bucket split — Option B — is unchanged; only the access property moved. This also supplies the Authorization Matrix row the thumbnail was missing.
- **IC-5** _(resolved_by phase-03-videos/TD-02)_ — TD-02 fixed the key as `{videoId}/source.mp4` with a hardcoded extension while TD-09, decided one cycle earlier, accepts both `video/mp4` and `video/webm`. Resolved as an **Append revision** to TD-02: the video object key is now **extension-less** (`{videoId}/source`; the thumbnail keeps `{videoId}/default.jpg`), with the stored `Content-Type` and the `format_name` column from TD-05's revision carrying the container information. Deriving the extension from the container was rejected because it forces the worker to resolve the extension before reading; narrowing the allowlist to MP4 was rejected because it reopens a parameter decided one cycle earlier and shrinks what the phase accepts.
- **AMB-1** _(resolved_by phase-03-videos/TD-08)_ — `rascunho` was undefined between processing status and publication visibility. Resolved as an **Append revision** to TD-08 separating two orthogonal axes: `processing_status` (the TD's enum) and `visibility` (own column, default `draft`). Phase 03 only occupies `draft` and implements no publication transition — publishing is a Phase 04 capability per `project-plan.md`.
- **AMB-2** _(resolved_by phase-03-videos/TD-07)_ — The actor for "Download do vídeo pelo usuário" was unnamed. Resolved as an **Append revision** to TD-07: streaming and download are authenticated and restricted to the video owner in this phase, both under the global `JwtAuthGuard` with an ownership check. Direct consequence of AMB-1's resolution. _(This resolution is what surfaced IC-4 — the thumbnail bucket's anonymous access was not re-examined against it until the next validate pass, which is where it was caught and closed.)_
- **AMB-3** _(resolved_by phase-03-videos/TD-05)_ — `metadados` was open-ended. Resolved as an **Append revision** to TD-05 fixing the persisted fields: `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `format_name`, `size_bytes`, `bitrate`, all from one `ffprobe -print_format json` call. The three codec/container fields are what makes TD-09's acceptance rule verifiable in the database — and `format_name` is now also what carries the container after IC-5 dropped the key extension.
