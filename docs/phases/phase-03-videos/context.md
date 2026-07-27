---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-25T18:41:10Z"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-27T02:10:44Z"
  docs/decisions/technical-decisions-nestjs-test-infrastructure.md: "2026-07-25T21:24:34Z"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-27T01:44:14Z"
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

> `project-plan.md` não declara subprojetos em fase alguma — `plan-reader` reportou `_Not declared._`, e o campo é preenchido aqui, como nas Fases 01 e 02. A atribuição acima deriva das 9 capabilities (todas de backend: storage, fila, worker, entidade, endpoints) e do enunciado da fase, que define a entrega como API, worker e infraestrutura.

**Sequencing notes:** `> Depende de: Fase 01, Fase 02` — Fase 03 is itself a declared dependency of Fase 04 (`> Depende de: Fase 02, Fase 03`) and Fase 05 (`> Depende de: Fase 03, Fase 04`). Phase framing sentence: "Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única."

**Neighbors (for boundary detection only):**

- **Phase 02:** `### Fase 02 — Cadastro, Login e Gerenciamento de Conta` — `> Depende de: Fase 01`
- **Phase 04:** `### Fase 04 — Gerenciamento de Vídeos e Canal` — `> Depende de: Fase 02, Fase 03`

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries | Renders in |
|-----|--------|-------|-------|--------|----------|-----------|------------|
| phase-03-videos/TD-01 | phase | Backend | Tecnologia de fila para o processamento em segundo plano | decided | A (BullMQ sobre Redis) | bullmq, @nestjs/bullmq | — |
|     └─ Last revision: 2026-07-26 — Registra no campo `**Libraries:**` as bibliotecas que a Recommendation já… | | | | | | | |
| phase-03-videos/TD-02 | phase | Backend | Organização de buckets e chaves no object storage | decided | B (Buckets separados por finalidade) | — | — |
|     └─ Last revision: 2026-07-26 — A chave do objeto de vídeo passa a ser **sem extensão**: `{videoId}/source`… | | | | | | | |
| phase-03-videos/TD-03 | phase | Backend | Protocolo de upload de arquivos de até 10GB | decided | A (Multipart com URLs pré-assinadas por parte) | — | — |
| phase-03-videos/TD-04 | phase | Backend | Onde e como o worker de processamento roda | decided | A (Container separado, mesma base de código) | — | — |
|     └─ Last revision: 2026-07-26 — FFmpeg e ffprobe passam a ser instalados **também na imagem da API/dev**, não… | | | | | | | |
| phase-03-videos/TD-05 | phase | Backend | Ferramenta de extração de metadados e geração de thumbnail | decided | A (child_process chamando ffmpeg/ffprobe direto) | — | — |
|     └─ Last revision: 2026-07-26 — Fixa os metadados que a fase **persiste** a partir da saída de `ffprobe… | | | | | | | |
| phase-03-videos/TD-06 | phase | Backend | Identificador público único por vídeo | decided | B (Slug curto aleatório em coluna própria) | — | — |
| phase-03-videos/TD-07 | phase | Backend | Estratégia de entrega — streaming e download | decided | A (Redirect para URL pré-assinada de GET) | — | — |
|     └─ Last revision: 2026-07-26 — Fixa o ator das rotas de streaming e download nesta fase: **autenticado e… | | | | | | | |
| phase-03-videos/TD-08 | phase | Backend | Ciclo de status, retry, dead letter e idempotência | decided | A (Enum no banco + retry nativo do BullMQ) | — | — |
|     └─ Last revision: 2026-07-26 — Separa dois eixos que estavam implícitos num só: `processing_status` (o enum… | | | | | | | |
| phase-03-videos/TD-09 | phase | Backend | Política de inputs aceitos e onde ela é validada | decided | A (Declaração validada na iniciação + verificação real no worker) | — | — |
| phase-03-videos/TD-10 | phase | Backend | Cliente S3 para Node — presign de parte, presign de GET e… | decided | A (@aws-sdk/client-s3 + @aws-sdk/s3-request-presigner) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02, phase-03-videos/TD-10 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03, phase-03-videos/TD-09, phase-03-videos/TD-10 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-03, phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-08, phase-03-videos/TD-09 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07, phase-03-videos/TD-10 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07, phase-03-videos/TD-10 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** A carga da fase é de dezenas de jobs por dia, então throughput não é critério de desempate — o que decide é qual opção entrega retry, backoff e dead letter com menos código próprio, e qual integra melhor com NestJS 11. BullMQ ganha nos dois: `@nestjs/bullmq` 11 é a integração oficial da mesma major do framework, e TD-08 vira configuração em vez de implementação. Kafka é descartável de saída — é event streaming resolvendo um problema que não existe aqui. RabbitMQ seria a escolha certa se a fase precisasse de roteamento por exchange ou garantias transacionais de entrega, e não precisa: é um único tipo de job, um único consumidor. Restaria o argumento de durabilidade, e ele se resolve habilitando persistência AOF no Redis — mais barato que adotar um broker novo. A familiaridade do usuário não é o motivo da escolha, mas reforça-a: reduz risco de operação num escopo que já é o maior da fase.
**Libraries:** bullmq, @nestjs/bullmq

**Revisions:**
- 2026-07-26 — Registra no campo `**Libraries:**` as bibliotecas que a Recommendation já nomeava em prosa: `bullmq` e `@nestjs/bullmq`. FFmpeg e ffprobe (TD-04/TD-05) ficam deliberadamente **fora** do campo — são binários instalados pelo Dockerfile, não pacotes npm. _Rationale:_ o `library-refs.md` é montado a partir deste campo e o `/plan-build` o consome para redigir as ações técnicas; com o campo vazio a biblioteca não tem origem rastreável e a consulta obrigatória via context7 fica sem alvo. Levantado como `IC-1` pelo `/plan-validate 03`.

### phase-03-videos/TD-02

**Recommendation:** O critério decisivo é a fronteira de acesso, não a conveniência: thumbnail é servida a usuários anônimos e vídeo bruto nunca deve ser, e essa distinção fica muito mais difícil de errar quando é uma propriedade do bucket em vez de um prefixo dentro de um bucket compartilhado. Dentro de cada bucket, manter a chave com o `videoId` (`{videoId}/source.mp4`, `{videoId}/default.jpg`) preserva a inspecionabilidade que a Option C perde. O custo é provisionar dois buckets no bootstrap — trivial, e feito uma vez.
**Libraries:** —

**Revisions:**
- 2026-07-26 — O bucket de thumbnails passa a ser **privado nesta fase**, servido pelo mesmo caminho da TD-07 (redirect para URL pré-assinada de `GET` + verificação de propriedade). A separação em dois buckets — a Option B — não muda; muda a propriedade de acesso do bucket de thumbnails, que vira público na fase que introduzir publicação (Fase 04). _Rationale:_ a justificativa original desta TD assumia serviço anônimo ("thumbnail é servida a usuários anônimos"), premissa que a revisão de 2026-07-26 da TD-07 invalidou para esta fase ao barrar acesso anônimo a conteúdo `draft`. O thumbnail não é conteúdo independente: a TD-05 o gera de um frame do próprio vídeo e esta TD o guarda ao lado da fonte, então um bucket público entregaria a anônimos um frame de vídeo restrito ao dono — exatamente a exposição que a TD-07 recusou. Fecha também a linha da Authorization Matrix que faltava para o thumbnail. Levantado como `IC-4` pelo `/plan-validate 03`.
- 2026-07-26 — A chave do objeto de vídeo passa a ser **sem extensão**: `{videoId}/source` (o thumbnail segue `{videoId}/default.jpg`). O `Content-Type` guardado no objeto e a coluna `format_name` que a revisão da TD-05 persiste carregam a informação de contêiner. _Rationale:_ esta TD fixava `{videoId}/source.mp4` com extensão hardcoded, e a TD-09 decidiu aceitar `video/mp4` **e** `video/webm` — um WebM guardado numa chave chamada `source.mp4` é contradição que o implementador não resolve por convenção, e a chave entra no Data Model, no payload de Events/Messages e na assinatura do `GET` da TD-07. Extensão derivada do contêiner foi descartada por obrigar o worker a resolver a extensão antes de ler o objeto; estreitar o allowlist para MP4 foi descartado por reabrir parâmetro decidido um ciclo atrás e encolher o que a fase aceita. Levantado como `IC-5` pelo `/plan-validate 03`.

### phase-03-videos/TD-03

**Recommendation:** A Option B está tecnicamente eliminada: 5GB não atende a um requisito de 10GB, e isso é limite do protocolo, não de configuração. Entre A e C, A não acrescenta serviço algum ao Compose e mantém o byte indo direto do cliente ao storage, que é exatamente o que o critério de reprova exige. Duas consequências de implementação precisam ser tratadas no plano, não descobertas depois: **(1)** as URLs pré-assinadas são consumidas pelo *cliente*, então precisam apontar para um endereço que o cliente alcança — o nome de serviço do Compose (`minio:9000`) resolve dentro da rede Docker mas não do navegador, o que exige configurar o endpoint público do MinIO separadamente do endpoint interno; **(2)** um lifecycle rule para expirar multipart incompleto é obrigatório, senão uploads abandonados acumulam partes órfãs silenciosamente.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** A Option B é a que mais economiza esforço agora e a que mais cobra depois: o ponto inteiro de processar em segundo plano é não deixar um vídeo de 10GB afetar quem está navegando, e rodar no mesmo processo desfaz isso. A Option C paga um preço de duplicação que só compensaria se o worker tivesse stack diferente, e não tem. A Option A entrega o isolamento sem duplicar domínio, e é a única compatível com o `software-arch.mermaid`. Duas consequências para o plano: o novo serviço precisa entrar em `scripts/run-gate.mjs` com seus gate ids (via skill `gate-builder`), e o Dockerfile do worker precisa instalar FFmpeg e ffprobe.
**Libraries:** —

**Revisions:**
- 2026-07-26 — FFmpeg e ffprobe passam a ser instalados **também na imagem da API/dev**, não apenas na do worker. O worker segue em container separado — a Option A não muda. _Rationale:_ a suíte roda dentro do container `nestjs-api`, e a política de external systems (`testing-guide-nestjs-project`) proíbe mockar o que o Compose roda de verdade; sem o binário ali, o teste de integração do serviço de processamento só poderia mockar o `child_process`. Agravado pela TD-09, que fez o `ffprobe` ser o portão autoritativo dos inputs aceitos — a própria política de aceitação ficaria não-testável onde o binário não existe. As alternativas foram descartadas por custo: gate id separado no container do worker parte a suíte em dois lugares, mexendo justamente no requisito "suíte completa verde"; adaptador com mock estreita a política de não-mock. Levantado como `IC-2` pelo `/plan-validate 03`.

### phase-03-videos/TD-05

**Recommendation:** A Option B seria a escolha natural e é justamente a que precisa ser evitada: está arquivada. A Option C troca desempenho por uma conveniência que o container já resolve. Chamar `ffprobe`/`ffmpeg` diretamente custa uma camada fina de código, sem dependência que possa apodrecer, e o `ffprobe` devolvendo JSON nativamente elimina a parte historicamente frágil (parsing de saída textual). Usar `execFile` com array de argumentos, nunca `exec` com string interpolada — nome de arquivo vindo do usuário em linha de comando é vetor de injeção.
**Libraries:** —

**Revisions:**
- 2026-07-26 — Fixa os metadados que a fase **persiste** a partir da saída de `ffprobe -print_format json`: `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `format_name`, `size_bytes`, `bitrate`. Sem coluna com o JSON bruto — seria dado guardado sem consumidor identificado nesta fase. _Rationale:_ a capability nomeia apenas "duração e metadados", e o `/plan-build` precisa de colunas concretas para o Data Model e de um shape concreto para o payload de Events/Messages. Os três campos de codec/container não são opcionais: são o que torna verificável no banco a regra de aceitação da TD-09. Levantado como `AMB-3` pelo `/plan-validate 03`.

### phase-03-videos/TD-06

**Recommendation:** O ganho decisivo não é a URL mais bonita, é o desacoplamento: URL publicada é um compromisso permanente com o usuário, e amarrá-la à chave primária significa que qualquer mudança futura de estratégia de PK quebra links que já circulam. A Option C amarra a URL a um campo que a Fase 04 torna editável, o que é pior. O custo da B é uma coluna com índice único e tratamento de colisão — e o projeto já tem esse padrão pronto e testado na geração de nickname de canal, que pode ser reaproveitado em vez de reinventado.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** É a opção coerente com a decisão que a fase já tomou no upload: se o argumento para não passar 10GB pela API na entrada é válido, ele vale igualmente na saída, onde o volume acumulado é maior (um upload, muitas reproduções). Além disso, `Range`/`206` correto é código sutil, e o S3/MinIO já o implementa — reescrevê-lo na API é assumir risco sem contrapartida. A Option C é eliminada por inviabilizar o *unlisted* da Fase 04. O ponto fraco reconhecido da A é o controle de acesso virar janela temporal: mitiga-se com expiração curta (minutos) e mantendo a validação de status/visibilidade no endpoint que emite o redirect — o que também dá o gancho natural para contagem de views na Fase 05.
**Libraries:** —

**Revisions:**
- 2026-07-26 — Fixa o ator das rotas de streaming e download nesta fase: **autenticado e restrito ao dono do vídeo**. Ambas ficam sob o `JwtAuthGuard` global com verificação de propriedade, sem `@Public()`. _Rationale:_ consequência direta da revisão da TD-08 — se todo vídeo da Fase 03 nasce e permanece `draft` e a transição de publicação pertence à Fase 04, não existe vídeo publicado para servir a anônimo, e abrir a rota exporia rascunho de terceiro. A rota nasce estruturada para as Fases 04/05 relaxarem o gate quando `visibility = published`, sem reescrever o mecanismo. Fecha as linhas da Authorization Matrix que o plano precisa emitir. Levantado como `AMB-2` pelo `/plan-validate 03`.

### phase-03-videos/TD-08

**Recommendation:** A Option C é eliminada por acoplar leitura de vídeo à disponibilidade do Redis e por perder o estado quando o job expira — a Fase 04 precisa listar vídeos por status, e isso tem que ser uma consulta SQL. A Option B resolve um problema de auditoria que o enunciado não pede, ao custo de infraestrutura de máquina de estados para cinco estados lineares. A Option A entrega o essencial com o que a stack já oferece. Três pontos que o plano precisa fixar explicitamente, porque são onde esse desenho costuma falhar: **(1)** distinguir falha transitória (repetir) de permanente (marcar `failed` sem gastar tentativas); **(2)** a guarda de idempotência no início do handler, já que a entrega é *at-least-once*; **(3)** o job precisa ser enfileirado **depois** do commit da transação que muda o status, senão o worker pode buscar uma linha que ainda não existe — condição de corrida clássica e difícil de reproduzir.
**Libraries:** —

**Revisions:**
- 2026-07-26 — Separa dois eixos que estavam implícitos num só: `processing_status` (o enum desta TD — `uploading → processing → ready | failed`) e `visibility` (coluna própria, default `draft`). São ortogonais. A Fase 03 **só ocupa `draft`** e não implementa transição de publicação; a coluna existe para a Fase 04 apenas acrescentar a transição. _Rationale:_ a capability "pré-cadastro automático do vídeo como rascunho ao iniciar o upload" não dizia se `rascunho` era estado de processamento ou de publicação. Um enum único produziria estados impossíveis ("publicado mas ainda processando") e exigiria migration na Fase 04 para separar. Publicar é capability da Fase 04 pelo `project-plan.md` — antecipá-la aqui seria escopo indevido. Levantado como `AMB-1` pelo `/plan-validate 03`.

### phase-03-videos/TD-09

**Recommendation:** A Option C está tecnicamente fora (não existe sob multipart pré-assinado) e a Option B abandona a única defesa possível do teto de 10GB. Restam os parâmetros, que precisam ser fixados aqui e não descobertos na implementação:
- **Allowlist: `video/mp4` e `video/webm`.** É a escolha que mantém o entregável honesto. Como a TD-07 serve o original e esta fase não transcodifica, aceitar `.mkv` ou `.mov` significaria aceitar arquivos que o navegador não toca — "streaming funcionando" passaria a valer só para parte dos uploads. MP4 e WebM são os dois contêineres que os navegadores reproduzem nativamente, então tudo que é aceito é reproduzível. Ampliar o allowlist é assunto da fase que introduzir transcodificação: não há capability de transcodificação na Fase 03, e criar uma seria requisito inventado.
- **Verificação do worker:** `format_name` do `ffprobe` compatível com o allowlist **e** existência de ao menos um stream de vídeo. Falhar qualquer uma das duas → `failed` permanente, sem consumir `attempts`.
- **Sem limite de duração.** Nenhuma capability da fase pede um, e o enunciado fixa o limite em tamanho (10GB), não em tempo. Um teto de duração seria requisito sem origem identificável.
- **Uma constante, dois consumidores.** O allowlist mora num único módulo de `src/videos/` importado pela API e pelo worker — a TD-04 mantém os dois na mesma base de código, então a divergência que é o `Con` da Option A se resolve por construção, não por disciplina.
**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** As quatro operações que a fase precisa foram confirmadas como API pública documentada nesta pesquisa, enquanto a Option B exige API interna justamente na operação central da TD-03 — e o projeto já estabeleceu, na TD-05, que depender de superfície instável ou não mantida é dívida a evitar na origem, não a aceitar por conveniência de sintaxe. A Option C troca uma dependência por código criptográfico próprio, sem nada em troca. Duas consequências para o plano, ambas herdadas de decisões anteriores e agora com solução concreta:
- **Dois endpoints, um cliente.** `endpoint: http://minio:9000` (nome de serviço do Compose, como o `CLAUDE.md` exige) para o que o servidor faz por conta própria — criar buckets, aplicar lifecycle, iniciar e completar multipart; e um endpoint público, vindo de env própria, para **assinar** as URLs que o navegador vai consumir. É a armadilha nº 1 da TD-03 resolvida por configuração explícita, e não é licença para `localhost` em host de serviço: é um segundo valor, declarado, com finalidade única.
- **`forcePathStyle: true`** é obrigatório contra MinIO — sem ele o SDK monta URL virtual-hosted (`bucket.minio:9000`), que não resolve na rede do Compose.
- Versão a fixar em `library-refs.md` pelo `/plan-resolve`. O context7 confirmou o **formato da API** (`getSignedUrl`, `UploadPartCommand`, `PutBucketLifecycleConfigurationCommand`, `endpoint` + `forcePathStyle`); a versão exata continua sendo item de confirmação daquele estágio.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

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

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### nestjs-test-infrastructure/TD-01

**Recommendation:** Mount `node_modules` as a **named volume** (`nestjs_node_modules`) over the bind-mounted project directory, so module resolution happens on the container filesystem. Measured: `require('@nestjs/core')` costs 12 017 ms through the Windows bind mount vs 228 ms from the container filesystem. `Dockerfile.dev` must create `/home/node/app/node_modules` owned by `node` **before** `USER node`, or the volume is created as root and `npm install` fails with `EACCES`.
**Libraries:** —

### nestjs-test-infrastructure/TD-02

**Recommendation:** Suites write to a **separate `streamtube_test` database** on the same `db` service, selected via `DOTENV_CONFIG_PATH=.env.test` on every `test*` script (the existing `setupFiles: ["dotenv/config"]` already honours that variable, so no loader code was added). Schema provisioning lives in `test/global-setup.ts`, registered as `globalSetup` in both Jest configs — it creates the database if absent and runs the migrations, since `AppModule` uses `synchronize: false`. Chosen over chaining migrations in the npm script because it also protects `npx jest path/to/file`.
**Libraries:** —

### nestjs-test-infrastructure/TD-03

**Recommendation:** `--forceExit` on every test script (`test`, `test:cov`, `test:integration`, `test:e2e`), matching the team's other repository. This is a **safety net, not a licence to leak** — suites must still `destroy()` / `app.close()` in a `finally`. `--detectOpenHandles` is deliberately NOT in the default scripts and lives in a dedicated `test:handles` script for diagnosis.
**Libraries:** —

### nestjs-test-infrastructure/TD-04

**Recommendation:** `.env.test` is **committed**. It holds only throwaway values for a local test database and no real secret; the sole load-bearing value is `DB_NAME=streamtube_test`. Committing it means cloning the repo requires no manual setup step before the suite is safe to run. `.gitignore` already excludes only `.env` and `.env.test.local`, so no change was needed there.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** **Option A (`@nestjs/swagger`)** — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger
**Revisions:**
- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** **Option C (Ambos)** — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** **Option B (Apenas em dev/staging)** — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
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

_None._

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

### next-frontend

_Deferred subproject — no work in this phase; testing requirements not applicable._
