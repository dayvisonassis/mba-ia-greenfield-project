---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 8
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-26T15:14:27Z"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-26T14:51:28Z"
issues:
  - id: IC-1
    status: open
    summary: "All 10 current-scope TDs carry Libraries: — while TD-01 prose names @nestjs/bullmq 11"
  - id: IC-2
    status: open
    summary: "ffmpeg only in worker image vs no-mocking policy for the API test suite"
  - id: IC-3
    status: open
    summary: "Committed openapi.json is a maintained artifact but no phase step regenerates it"
  - id: MD-1
    status: resolved
    summary: "No TD decides accepted input policy (container/codec/mime) nor where it is validated"
    resolved_by: phase-03-videos/TD-09
  - id: MD-2
    status: resolved
    summary: "No TD names the S3/MinIO client library required by TD-02, TD-03 and TD-07"
    resolved_by: phase-03-videos/TD-10
  - id: AMB-1
    status: open
    summary: "'rascunho' undefined: processing status or publication visibility; exit transition"
  - id: AMB-2
    status: open
    summary: "'Download do vídeo pelo usuário' — owner only or any viewer/anonymous"
  - id: AMB-3
    status: open
    summary: "'extração de duração e metadados' — which metadata fields are persisted"
  - id: OQ-1
    status: open
    summary: "TD-09 pending — política de inputs aceitos e onde ela é validada"
  - id: OQ-2
    status: open
    summary: "TD-10 pending — cliente S3 para Node (presign de parte, presign GET, lifecycle)"
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

- **IC-1** — The `Libraries` column of `## Decisions Index` is `—` for **all 10 current-scope TDs**, while `## Decisions Detail` names concrete packages and binaries in the Recommendation prose of the same TDs: phase-03-videos/TD-01 states "`@nestjs/bullmq` 11 é a integração oficial da mesma major do framework" and picks "BullMQ sobre Redis"; phase-03-videos/TD-04 states "o Dockerfile do worker precisa instalar FFmpeg e ffprobe"; phase-03-videos/TD-05 decides "`child_process` chamando `ffmpeg`/`ffprobe` direto". The contrast with the inherited block is now explicit in the same file: every inherited TD that introduced a dependency records it (`@nestjs/config@^4.x`, `joi@^17.x`, `argon2@^0.41.x`, `@nestjs/swagger`, iron-session), so the empty column is a property of this phase alone, not of the format. A decided technology recorded only in prose is invisible to the pipeline's structured consumers: `/plan-resolve` builds `library-refs.md` from the `Libraries` field and `/plan-build` reads `library-refs.md` to draft Technical actions. With every field empty, `library-refs.md` is born empty, the mandatory context7 lookup has no target, and plan-build would draft BullMQ/FFmpeg/S3 steps against unverified APIs. Explicit choice: populate `**Libraries:**` on each TD whose decision introduces a dependency — at minimum TD-01 → `bullmq` + `@nestjs/bullmq`, and TD-10 → the S3 client packages once OQ-2 closes. Keep `ffmpeg`/`ffprobe` **out** of the field and in the TD-04/TD-05 prose where they already are: they are container binaries installed by the Dockerfile, not npm packages, and feeding them to `/plan-resolve`'s Step 5 would send a registry/context7 lookup after something that has no package to resolve — a failed lookup aborts the whole stage under its network-failure policy.

- **IC-2** — `## Testing Requirements` carries the external-systems policy verbatim — *"PostgreSQL, message queue and email run **real** in Docker for integration tests — do not mock what the Compose stack can run for real"* — and maps `Service with side-effect dep (email, storage)` to *"Integration: real capture service (Mailpit) or local adapter"*. That policy collides with phase-03-videos/TD-04, which scopes the FFmpeg install to a single image: *"o Dockerfile do worker precisa instalar FFmpeg e ffprobe"*, combined with phase-03-videos/TD-05 deciding the metadata/thumbnail service shells out to those binaries via `child_process`. The backend suite executes inside the `nestjs-api` container, which under TD-04 has no `ffmpeg`/`ffprobe` — so an integration test of the processing service can only mock the binary (violating the policy) or fail to spawn it. The collision now reaches further than the suite: phase-03-videos/TD-09's Recommendation makes the worker's `ffprobe` call the **authoritative gate** for accepted inputs ("`format_name` do `ffprobe` compatível com o allowlist **e** existência de ao menos um stream de vídeo"), so the acceptance policy itself becomes untestable wherever the binary is absent. TD-04 also already requires the worker's gate ids in `scripts/run-gate.mjs`, and that wiring has to declare *which container* runs the video-processing tests. Explicit choice: (a) install `ffmpeg`/`ffprobe` in the API/test image as well, so integration tests spawn the real binary where the suite already runs; (b) declare the video-processing integration tests as a worker-container gate id and run them there, keeping the API image slim; (c) amend TD-05 to isolate the `child_process` call behind an adapter whose integration test runs in the worker while the API-side unit test uses the adapter's contract — an explicit, documented narrowing of the no-mocking policy.

- **IC-3** — The inherited block establishes the committed OpenAPI spec as a **maintained artifact**: openapi-docs-nestjs/TD-02 chose *"Option C (Ambos)"* precisely so there is "uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa", and openapi-docs-nestjs/TD-03 leans on it — *"o `openapi.json` commitado em TD-02 cumpre o papel de 'spec consultável fora da UI'"*. openapi-docs-nestjs/TD-01's `**Revisions:**` entry of 2026-05-12 goes further, fixing that operations, per-status response schemas and error contracts "exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`)" and that this enrichment "faz parte da Option A escolhida, não é trabalho fora do escopo do TD". Against that, this phase introduces an entirely new HTTP surface — upload initiation and completion (TD-03), the streaming and download redirects (TD-07) — and neither its `**Deliverables:**` ("upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas") nor any of its ten TDs carries the obligation to regenerate and commit the spec. Left as is, the phase ships an API whose committed contract does not describe it, which is documentation contradicting code — and the spec is versioned, so the drift lands visibly in the delivery diff. Explicit choice: (a) record the spec refresh as an explicit obligation of this phase so `/plan-build` emits it in Deliverables (regenerate via the existing export script and commit the result, with the explicit decorators TD-01's revision requires); (b) append a revision to openapi-docs-nestjs/TD-02 stating that every phase adding endpoints owns the refresh, making it a standing rule instead of a per-phase reminder; (c) declare explicitly that the spec is refreshed outside this phase, accepting the documented drift until then.

### Ambiguities

- **AMB-1** — Capability *"Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"* does not define what `rascunho` **is** in the data model, and `## Capability Coverage` maps it to two TDs that model different things: phase-03-videos/TD-03 (upload protocol) and phase-03-videos/TD-08, whose decision is a status enum for the *processing* lifecycle ("Ciclo de status, retry, dead letter e idempotência"). Processing status (`uploading → processing → ready | failed`) and publication visibility (`rascunho → publicado`) are orthogonal axes, and the phase boundary makes the distinction load-bearing: the neighbor Phase 04 is *"Gerenciamento de Vídeos e Canal"*, and phase-03-videos/TD-07 already defers *unlisted* to it. Neither of the two TDs added since the last revision touches this — TD-09 decides accepted inputs, TD-10 decides the storage client. Without the distinction, `/plan-build` cannot write the Data Model (one enum column or two?) and cannot state what transition takes a video out of `rascunho` — nor whether such a transition exists at all in this phase. Explicit choice: decide whether `rascunho` is a value of TD-08's processing enum or a separate visibility column, and state which transition (if any) Phase 03 owns versus what is deferred to Phase 04 — recorded either as a `**Revisions:**` block on TD-08 or as a new TD.

- **AMB-2** — Capability *"Download do vídeo pelo usuário"* does not name the actor. `usuário` can mean the owner of the video (download of my own upload) or any viewer, including the anonymous ones the project overview says may watch freely. The two readings produce different Authorization Matrices and different endpoint contracts: owner-only means the download route sits behind the global `JwtAuthGuard` with an ownership check; any-viewer means it is `@Public()` and gated only by video state. phase-03-videos/TD-07 covers the *mechanism* for both ("Redirect para URL pré-assinada de `GET`") and gestures at the gate — *"mantendo a validação de status/visibilidade no endpoint que emite o redirect"* — without deciding the policy that validation enforces. The same question applies to the streaming route, which shares TD-07, and it compounds with AMB-1: if every video in this phase stays `rascunho`, "any viewer" may have no reachable object at all. Explicit choice: define the actor for the download and streaming routes (owner-only / authenticated / anonymous), which fixes both the Authorization Matrix rows and the presigned-URL expiry posture.

- **AMB-3** — Capability *"Processamento automático do vídeo após upload (extração de duração e metadados)"* names exactly one concrete field (duração) and leaves `metadados` open. `/plan-build` must emit a Data Model with specific columns and an Events/Messages payload with a specific shape, and `ffprobe` exposes far more than can be persisted by default (resolution, codec de vídeo e áudio, bitrate, framerate, container, tamanho em bytes). phase-03-videos/TD-05 decides *how* to read them ("`ffprobe` devolvendo JSON nativamente") but not *which* are stored. The gap narrowed since the last revision without closing: phase-03-videos/TD-09 now requires `format_name` and the presence of a video stream to be **read** at validation time, and its Recommendation notes the interaction explicitly — "codec/container fields are what make an input-acceptance rule enforceable" — but reading a field is not the same as persisting it, and the column list remains undecided. Explicit choice: enumerate the metadata fields the phase persists on the video entity, stating for each whether it exists to satisfy the capability or to support TD-09's acceptance rule.

### Missing Decisions

_None._ Both prior `MD-N` issues were closed by the `/research` cycle that added phase-03-videos/TD-09 (accepted-input policy and its enforcement point) and phase-03-videos/TD-10 (S3 client for Node) — see `## Resolved Issues`. Every bullet in `## Capability Coverage` maps to at least one TD, and the error-response format for the new HTTP surface is covered by the inherited phase-02-auth/TD-07 (Custom Domain Exception Filter), so the first-HTTP-in-subproject sub-check does not fire. The shared-types contract-sync sub-type does not apply: `## UI Inventory` is absent (`ui_in_scope: false`), and that sub-type never fires without active UI scope.

### Dependency Gaps

_None._ Phase 03 declares `> Depende de: Fase 01, Fase 02`, and both prerequisites its capabilities imply are inherited and present: the namespaced `registerAs` config foundation — which phase-01-configuracao-base/TD-03 explicitly anticipated for storage (*"the project roadmap explicitly calls for auth, email, and storage in upcoming phases"*) — and the authenticated-user plus channel ownership surface from Phase 02. Within-phase ordering is implied by the TD dependency structure (storage and queue before upload, upload before processing, processing before delivery) and is `/plan-build`'s Dependency Map to formalize.

### Inherited Constraint Conflicts

_None._ The six inherited conventions are all backend-config mechanics (`@nestjs/config` namespaced factories, Joi env validation, `ConfigType` injection, `data-source.ts` factory reuse, `TypeOrmModule.forRootAsync` with `synchronize: false`), and no phase-03 TD contradicts them — the Redis, storage and public-endpoint settings introduced by TD-01, TD-02 and TD-10 are new namespaced configs that follow the pattern rather than departing from it. The correlated inherited TDs added in this revision are likewise compatible: nestjs-test-infrastructure fixes where suites run and how they exit, and openapi-docs-nestjs fixes how endpoints are documented; the tension the latter creates is an unmet obligation, not a contradiction, and is filed as IC-3.

### Unresolved Open Questions

- **OQ-1** — phase-03-videos/TD-09 pending — política de inputs aceitos e onde ela é validada. The TD is written with three options (declaration validated at initiation + truth in the worker; worker-only; conditions signed into the presigned URL, eliminated as incompatible with TD-03's multipart) and a recommendation for Option A with concrete parameters (allowlist `video/mp4` + `video/webm`, `format_name` plus video-stream check in the worker, no duration cap, one shared constant). Resolution: fill the `**Decision:**` field of TD-09 in `docs/decisions/technical-decisions-phase-03-videos.md`, or let `/plan-resolve 03` present the options and write it; then re-run `/plan-validate 03`.

- **OQ-2** — phase-03-videos/TD-10 pending — cliente S3 para Node (presign de parte, presign de `GET`, lifecycle rule). The TD compares the AWS SDK v3 pair, the MinIO JS client and a hand-rolled SigV4 approach, with the API surface of each verified via context7, and recommends Option A. Resolution: fill the `**Decision:**` field of TD-10 in `docs/decisions/technical-decisions-phase-03-videos.md`, or let `/plan-resolve 03` present the options and write it; then re-run `/plan-validate 03`. Closing this one also unblocks part of IC-1, since the chosen packages are what `**Libraries:**` on TD-10 must record.

### UI Coverage Gaps

_None._ `## UI Inventory` is absent (`ui_in_scope: false`) — `## Scope` records `**Deferred subprojects:** next-frontend/` with the video interface out of scope for this phase — so UI coverage is not a concept here. All ten TDs carry `Scope: Backend`, so the Scope-Subsection orphan check does not fire either.

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-09)_ — No TD decided the accepted-input policy (container/codec/mime allowlist, duration cap) nor where it is enforced, given that TD-03 sends the bytes straight from client to storage. Closed by TD-09, which frames the choice as *where* enforcement lives, eliminates the presigned-POST-conditions option as incompatible with TD-03's per-part multipart, and carries the concrete parameters in its Recommendation. The TD is still `pending` a decision — tracked as OQ-1.
- **MD-2** _(resolved_by phase-03-videos/TD-10)_ — No TD named the S3/MinIO client required by TD-02 (bucket bootstrap), TD-03 (per-part presign plus the lifecycle rule that expires incomplete multipart) and TD-07 (presigned `GET`). Closed by TD-10, whose Options were verified against the libraries' own documentation via context7. The TD is still `pending` a decision — tracked as OQ-2.
