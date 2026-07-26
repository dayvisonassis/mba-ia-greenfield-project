---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-25T18:41:10Z"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-26T01:21:26Z"
  docs/decisions/technical-decisions-nestjs-test-infrastructure.md: "2026-07-25T21:24:34Z"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-25T18:41:10Z"
  docs/phases/phase-01-configuracao-base/context.md: "2026-07-25T18:41:10Z"
  docs/phases/phase-02-auth/context.md: "2026-07-25T18:41:10Z"
  docs/phases/phase-02-auth-frontend/context.md: "2026-07-25T18:41:10Z"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-25T18:41:10Z"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — a interface de vídeo (telas de upload, player, gerenciamento) não faz parte desta fase; o contrato HTTP produzido aqui é publicado via `openapi.json` e consumido pelo frontend nas Fases 04–05.

> `project-plan.md` não declara subprojetos em fase alguma — o campo é preenchido no `context.md`, como nas Fases 01 e 02. A atribuição acima deriva das 9 capabilities (todas de backend: storage, fila, worker, entidade, endpoints) e do enunciado da fase, que define a entrega como API, worker e infraestrutura.

**Sequencing notes:** `> Depende de: Fase 01, Fase 02` — Fase 03 is itself a declared dependency of Fase 04 (`> Depende de: Fase 02, Fase 03`) and Fase 05 (`> Depende de: Fase 03, Fase 04`). Phase framing sentence: "Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única."

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — Depende de: Fase 01
- **Phase 04:** Gerenciamento de Vídeos e Canal — Depende de: Fase 02, Fase 03

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Tecnologia de fila para o processamento em segundo plano | decided | A (BullMQ sobre Redis) | — |
| phase-03-videos/TD-02 | phase | Backend | Organização de buckets e chaves no object storage | decided | B (Buckets separados por finalidade) | — |
| phase-03-videos/TD-03 | phase | Backend | Protocolo de upload de arquivos de até 10GB | decided | A (Multipart com URLs pré-assinadas por parte) | — |
| phase-03-videos/TD-04 | phase | Backend | Onde e como o worker de processamento roda | decided | A (Container separado, mesma base de código) | — |
| phase-03-videos/TD-05 | phase | Backend | Ferramenta de extração de metadados e geração de thumbnail | decided | A (child_process chamando ffmpeg/ffprobe direto) | — |
| phase-03-videos/TD-06 | phase | Backend | Identificador público único por vídeo | decided | B (Slug curto aleatório em coluna própria) | — |
| phase-03-videos/TD-07 | phase | Backend | Estratégia de entrega — streaming e download | decided | A (Redirect para URL pré-assinada de GET) | — |
| phase-03-videos/TD-08 | phase | Backend | Ciclo de status, retry, dead letter e idempotência | decided | A (Enum no banco + retry nativo do BullMQ) | — |

_`Renders in` column omitted: no TD in scope sets the field (all `—`)._

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-03, phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-08 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** A carga da fase é de dezenas de jobs por dia, então throughput não é critério de desempate — o que decide é qual opção entrega retry, backoff e dead letter com menos código próprio, e qual integra melhor com NestJS 11. BullMQ ganha nos dois: `@nestjs/bullmq` 11 é a integração oficial da mesma major do framework, e TD-08 vira configuração em vez de implementação. Kafka é descartável de saída — é event streaming resolvendo um problema que não existe aqui. RabbitMQ seria a escolha certa se a fase precisasse de roteamento por exchange ou garantias transacionais de entrega, e não precisa: é um único tipo de job, um único consumidor. Restaria o argumento de durabilidade, e ele se resolve habilitando persistência AOF no Redis — mais barato que adotar um broker novo. A familiaridade do usuário não é o motivo da escolha, mas reforça-a: reduz risco de operação num escopo que já é o maior da fase.
**Libraries:** —

### phase-03-videos/TD-02

**Recommendation:** O critério decisivo é a fronteira de acesso, não a conveniência: thumbnail é servida a usuários anônimos e vídeo bruto nunca deve ser, e essa distinção fica muito mais difícil de errar quando é uma propriedade do bucket em vez de um prefixo dentro de um bucket compartilhado. Dentro de cada bucket, manter a chave com o `videoId` (`{videoId}/source.mp4`, `{videoId}/default.jpg`) preserva a inspecionabilidade que a Option C perde. O custo é provisionar dois buckets no bootstrap — trivial, e feito uma vez.
**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** A Option B está tecnicamente eliminada: 5GB não atende a um requisito de 10GB, e isso é limite do protocolo, não de configuração. Entre A e C, A não acrescenta serviço algum ao Compose e mantém o byte indo direto do cliente ao storage, que é exatamente o que o critério de reprova exige. Duas consequências de implementação precisam ser tratadas no plano, não descobertas depois: **(1)** as URLs pré-assinadas são consumidas pelo *cliente*, então precisam apontar para um endereço que o cliente alcança — o nome de serviço do Compose (`minio:9000`) resolve dentro da rede Docker mas não do navegador, o que exige configurar o endpoint público do MinIO separadamente do endpoint interno; **(2)** um lifecycle rule para expirar multipart incompleto é obrigatório, senão uploads abandonados acumulam partes órfãs silenciosamente.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** A Option B é a que mais economiza esforço agora e a que mais cobra depois: o ponto inteiro de processar em segundo plano é não deixar um vídeo de 10GB afetar quem está navegando, e rodar no mesmo processo desfaz isso. A Option C paga um preço de duplicação que só compensaria se o worker tivesse stack diferente, e não tem. A Option A entrega o isolamento sem duplicar domínio, e é a única compatível com o `software-arch.mermaid`. Duas consequências para o plano: o novo serviço precisa entrar em `scripts/run-gate.mjs` com seus gate ids (via skill `gate-builder`), e o Dockerfile do worker precisa instalar FFmpeg e ffprobe.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** A Option B seria a escolha natural e é justamente a que precisa ser evitada: está arquivada. A Option C troca desempenho por uma conveniência que o container já resolve. Chamar `ffprobe`/`ffmpeg` diretamente custa uma camada fina de código, sem dependência que possa apodrecer, e o `ffprobe` devolvendo JSON nativamente elimina a parte historicamente frágil (parsing de saída textual). Usar `execFile` com array de argumentos, nunca `exec` com string interpolada — nome de arquivo vindo do usuário em linha de comando é vetor de injeção.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** O ganho decisivo não é a URL mais bonita, é o desacoplamento: URL publicada é um compromisso permanente com o usuário, e amarrá-la à chave primária significa que qualquer mudança futura de estratégia de PK quebra links que já circulam. A Option C amarra a URL a um campo que a Fase 04 torna editável, o que é pior. O custo da B é uma coluna com índice único e tratamento de colisão — e o projeto já tem esse padrão pronto e testado na geração de nickname de canal, que pode ser reaproveitado em vez de reinventado.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** É a opção coerente com a decisão que a fase já tomou no upload: se o argumento para não passar 10GB pela API na entrada é válido, ele vale igualmente na saída, onde o volume acumulado é maior (um upload, muitas reproduções). Além disso, `Range`/`206` correto é código sutil, e o S3/MinIO já o implementa — reescrevê-lo na API é assumir risco sem contrapartida. A Option C é eliminada por inviabilizar o *unlisted* da Fase 04. O ponto fraco reconhecido da A é o controle de acesso virar janela temporal: mitiga-se com expiração curta (minutos) e mantendo a validação de status/visibilidade no endpoint que emite o redirect — o que também dá o gancho natural para contagem de views na Fase 05.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** A Option C é eliminada por acoplar leitura de vídeo à disponibilidade do Redis e por perder o estado quando o job expira — a Fase 04 precisa listar vídeos por status, e isso tem que ser uma consulta SQL. A Option B resolve um problema de auditoria que o enunciado não pede, ao custo de infraestrutura de máquina de estados para cinco estados lineares. A Option A entrega o essencial com o que a stack já oferece. Três pontos que o plano precisa fixar explicitamente, porque são onde esse desenho costuma falhar: **(1)** distinguir falha transitória (repetir) de permanente (marcar `failed` sem gastar tentativas); **(2)** a guarda de idempotência no início do handler, já que a entrega é *at-least-once*; **(3)** o job precisa ser enfileirado **depois** do commit da transação que muda o status, senão o worker pode buscar uma linha que ainda não existe — condição de corrida clássica e difícil de reproduzir.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use.
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection. (2) **Single cookie to manage** simplifies logout and avoids the orphan-cookie failure mode. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome without a per-render `/auth/me` round-trip.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh). Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions. (2) **Aligned with shadcn's canonical form primitive** — `npx shadcn@latest add form` produces react-hook-form wrappers. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level.
**Libraries:** —

### nestjs-test-infrastructure/TD-01

**Recommendation:** Mount `node_modules` as a **named volume** (`nestjs_node_modules`) over the bind-mounted project directory, so module resolution happens on the container filesystem. Measured: `require('@nestjs/core')` costs 12 017 ms through the Windows bind mount vs 228 ms from the container filesystem. `Dockerfile.dev` must create `/home/node/app/node_modules` owned by `node` **before** `USER node`, or the volume is created as root and `npm install` fails with `EACCES`.
**Libraries:** —

### nestjs-test-infrastructure/TD-02

**Recommendation:** Suites write to a **separate `streamtube_test` database** on the same `db` service, selected via `DOTENV_CONFIG_PATH=.env.test` on every `test*` script. Schema provisioning lives in `test/global-setup.ts`, registered as `globalSetup` in both Jest configs — it creates the database if absent and runs the migrations, since `AppModule` uses `synchronize: false`. Chosen over chaining migrations in the npm script because it also protects `npx jest path/to/file`.
**Libraries:** —

### nestjs-test-infrastructure/TD-03

**Recommendation:** `--forceExit` on every test script (`test`, `test:cov`, `test:integration`, `test:e2e`). This is a **safety net, not a licence to leak** — suites must still `destroy()` / `app.close()` in a `finally`. `--detectOpenHandles` is deliberately NOT in the default scripts and lives in a dedicated `test:handles` script for diagnosis.
**Libraries:** —

### nestjs-test-infrastructure/TD-04

**Recommendation:** `.env.test` is **committed**. It holds only throwaway values for a local test database and no real secret; the sole load-bearing value is `DB_NAME=streamtube_test`. Committing it means cloning the repo requires no manual setup step before the suite is safe to run.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger`) — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Ambos) — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Option B (Apenas em dev/staging) — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI").
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| _None._ | | | |

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

_Suffixes: `*.spec.ts` (unit), `*.integration-spec.ts` (integration, real DB), `*.e2e-spec.ts` (E2E via supertest, under `nestjs-project/test/`)._

_External systems policy (`references/external-systems.md`): PostgreSQL, message queue and email run **real** in Docker for integration tests — do not mock what the Compose stack can run for real._
