---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-27T02:13:56Z"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-27T02:13:57Z"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-27T20:37:45Z"
  docs/decisions/technical-decisions-nestjs-test-infrastructure.md: "2026-07-25T21:24:34Z"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-27T01:44:14Z"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar upload de vídeos de até 10GB sem passar o byte pela API, com pré-cadastro do vídeo como rascunho ao iniciar o upload, processamento automático em segundo plano que extrai duração e metadados e gera thumbnail de um frame, URL única por vídeo e entrega por streaming e download — no `nestjs-project/`, sem interface de vídeo (o `next-frontend/` fica diferido para as Fases 04–05).

---

## Step Implementations

### SI-03.1 — Infra: Redis, MinIO e configuração de ambiente

**Description:** Subir fila e storage como serviços reais no Compose e expor seus parâmetros pelas configs namespaced, para que nada nesta fase dependa de serviço instalado fora de container.

**Technical actions:**

1. Acrescentar os serviços `redis` e `minio` ao `nestjs-project/compose.yaml`, cada um com volume nomeado próprio; habilitar persistência AOF no Redis (per `phase-03-videos/TD-01`).
2. Acrescentar as variáveis de storage e fila a `.env`, `.env.example` e `.env.test` — endpoint interno, endpoint público de assinatura, credenciais, nomes dos dois buckets, host/porta do Redis. Valores com caracteres shell-especiais entram entre aspas (`nestjs-project/CLAUDE.md` § Environment File Conventions).
3. Estender o schema Joi em `src/config/env.validation.ts` com as novas chaves, todas obrigatórias.
4. Criar `src/config/storage.config.ts` e `src/config/queue.config.ts` como factories `registerAs` namespaced, injetáveis via `ConfigType<typeof xxxConfig>` (per `## Inherited Conventions`, fase 01).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `env.validation.ts` | Unit: schema rejeita ausência de cada nova chave obrigatória | `src/config/env.validation.spec.ts` |
| `storage.config.ts` + `queue.config.ts` | Unit: factory mapeia env → objeto tipado, endpoint interno ≠ endpoint público | `src/config/storage.config.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose ps` mostra `redis` e `minio` com status `running`, além de `nestjs-api` e `db`.
- Subir a API sem uma das novas variáveis de ambiente falha no boot com mensagem do Joi nomeando a chave ausente.
- Os dados do MinIO e do Redis sobrevivem a `docker compose down` (volumes nomeados, não anônimos).
- O endpoint interno de storage resolve pelo nome de serviço do Compose; o endpoint público é um segundo valor declarado, distinto do interno.

---

### SI-03.2 — Cliente S3: provedores, bootstrap de buckets e varredura de multipart

**Description:** Encapsular o acesso ao storage num módulo próprio, com os dois clientes que a fase exige e o provisionamento idempotente dos buckets.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` dentro do container (`docker compose exec nestjs-api npm install`) — versões conforme `library-refs.md`.
2. Criar `src/storage/storage.module.ts` com dois provedores de `S3Client`: um com o endpoint **interno** para operações servidor→storage e um com o endpoint **público** usado apenas para assinar URLs entregues ao cliente; ambos com `forcePathStyle: true`, obrigatório contra MinIO (per `phase-03-videos/TD-10`).
3. Criar `src/storage/storage.service.ts` expondo `createMultipartUpload`, `presignUploadPart`, `completeMultipartUpload`, `abortMultipartUpload`, `presignGetObject` e `putObject` — presign sempre via `getSignedUrl` do presigner com `expiresIn` explícito, nunca o default de 900s (per `phase-03-videos/TD-07`).
4. Implementar bootstrap idempotente na inicialização: criar `streamtube-videos` e `streamtube-thumbnails` se ausentes, **ambos privados** — nenhuma policy pública é aplicada (per `phase-03-videos/TD-02` e sua revisão).
5. Expor `listMultipartUploads(bucket)` no `StorageService`, devolvendo os uploads em curso com sua data de iniciação — é a metade de leitura da varredura que o SI-03.16 executa; a metade de escrita (`abortMultipartUpload`) já é entregue pela ação 3 (per `phase-03-videos/TD-03` revision). **Não** aplicar lifecycle rule: o MinIO desta fase não implementa `AbortIncompleteMultipartUpload` — recusa a regra quando é a única ação e a descarta em silêncio quando pareada.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration com MinIO real: bootstrap idempotente, `listMultipartUploads` enxerga um multipart em curso e deixa de enxergá-lo após o abort, round-trip de presign PUT/GET | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — os endpoints e credenciais vêm da config namedspaced criada lá.

**Acceptance criteria:**

- Subir a aplicação duas vezes seguidas não falha nem duplica buckets — o bootstrap é idempotente.
- Um multipart iniciado e não concluído aparece em `listMultipartUploads` com sua data de iniciação, e desaparece depois de `abortMultipartUpload` — é o par de operações sobre o qual a varredura do SI-03.16 se apoia.
- Uma requisição anônima a um objeto de qualquer um dos dois buckets é recusada pelo storage — nenhum bucket é legível sem assinatura.
- Uma URL pré-assinada de `GET` gerada pelo serviço aponta para o endpoint público, não para o nome de serviço do Compose.
- A URL pré-assinada expira no prazo configurado: uma requisição após a expiração é recusada pelo storage.

---

### SI-03.3 — Entidade `Video`, enums e migration

**Description:** Materializar o modelo de dados do vídeo, incluindo a separação entre estado de processamento e visibilidade que a fase decidiu.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com os campos, tipos e constraints exatamente como em `## Technical Specifications` → `### Data Model` → `#### Video`.
2. Gerar a migration criando a tabela `videos`, os dois tipos enum (`videos_processing_status_enum`, `videos_visibility_enum`), a FK para `channels`, o índice único de `slug` e os índices de `channel_id` e `processing_status` (per `phase-03-videos/TD-06` e `phase-03-videos/TD-08`).
3. Registrar os dois novos tipos enum em `MANAGED_ENUM_TYPES` do `migrations.integration-spec.ts` — enum do Postgres é objeto independente e sobrevive a `DROP TABLE ... CASCADE` (`nestjs-project/CLAUDE.md` § Test Database).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: defaults (`processing_status = uploading`, `visibility = draft`), unicidade de `slug`, FK com cascade, nullability dos campos de metadados | `src/videos/entities/video.entity.integration-spec.ts` |
| migrations | Integration: a suíte existente cobre up/down com os enums registrados | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none — o modelo não depende de storage nem de fila.

**Acceptance criteria:**

- Inserir um vídeo sem informar `processing_status` nem `visibility` grava `uploading` e `draft`.
- Inserir dois vídeos com o mesmo `slug` viola a constraint de unicidade.
- Remover o canal remove os vídeos associados.
- Rodar a migration para baixo e para cima em sequência não deixa tipo enum órfão — a suíte de migrations passa duas execuções consecutivas.
- Um vídeo recém-criado tem todos os campos de metadados (`duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `format_name`, `size_bytes`, `bitrate`) nulos.

---

### SI-03.4 — Geração do identificador público único

**Description:** Produzir o slug curto e aleatório que vira a URL pública do vídeo, com tratamento de colisão — reaproveitando o padrão já testado na geração de nickname de canal em vez de reinventá-lo.

**Technical actions:**

1. Criar `src/videos/video-slug.service.ts` gerando slug curto aleatório e reintentando sob colisão até um teto de tentativas, espelhando o padrão de `channels.service.ts` (per `phase-03-videos/TD-06`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoSlugService` | Unit: reintenta ao detectar colisão (repo mockado) e desiste no teto de tentativas | `src/videos/video-slug.service.spec.ts` |
| `VideoSlugService` | Integration: gera slug efetivamente único contra o índice real do banco | `src/videos/video-slug.service.integration-spec.ts` |

**Dependencies:** SI-03.3 — a checagem de colisão consulta a coluna `slug` e seu índice único.

**Acceptance criteria:**

- Gerar mil slugs em sequência não produz repetição.
- Quando a primeira tentativa colide com um slug existente, o serviço devolve um slug diferente e livre.
- Esgotado o teto de tentativas, o serviço falha explicitamente em vez de devolver slug duplicado.
- O slug gerado cabe no comprimento declarado da coluna e é seguro para uso em URL sem escaping.

---

### SI-03.5 — Registro da fila BullMQ

**Description:** Registrar a fila `video-processing` no NestJS, com a conexão vinda da config namespaced, para que produtor e consumidor compartilhem a mesma definição.

**Technical actions:**

1. Registrar `BullModule.forRootAsync` com `useFactory` injetando `queueConfig`, e `BullModule.registerQueue({ name: 'video-processing' })` no módulo de vídeos (per `phase-03-videos/TD-01` e `library-refs.md` → `@nestjs/bullmq`).
2. Definir as opções default do job na fila — `attempts` e `backoff: { type: 'exponential' }` — conforme `### Events/Messages`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| módulo com a fila registrada | Unit: compilation test — resolve o token da fila via DI | `src/videos/videos.module.spec.ts` |
| fila `video-processing` | Integration com Redis real: enfileirar e ler um job devolve o payload íntegro; fechar worker e queue em `finally` | `src/videos/video-queue.integration-spec.ts` |

**Dependencies:** SI-03.1 — host e porta do Redis vêm de `queue.config.ts`.

**Acceptance criteria:**

- O módulo compila e o token da fila `video-processing` é resolvível por injeção.
- Um job enfileirado aparece na fila do Redis e é lido com o mesmo payload que foi gravado.
- Um job que falha é reenfileirado com atraso crescente até o teto de `attempts`, e depois aparece no set `failed`.
- A suíte de integração da fila encerra sem deixar handle aberto — o Jest sai sem depender do `--forceExit`.

---

### SI-03.6 — Serviço de iniciação de upload

**Description:** Criar o vídeo como rascunho, validar a declaração do cliente e abrir o multipart pré-assinado — sem que nenhum byte do arquivo passe pelo processo Node.

**Technical actions:**

1. Criar `src/videos/constants/accepted-video-formats.ts` com o allowlist `video/mp4` e `video/webm` e o teto de 10 GiB — **constante única** importada pela API e pelo worker, que compartilham a base de código (per `phase-03-videos/TD-09`).
2. Criar `src/videos/dto/initiate-upload.dto.ts` com as regras de `### API Contracts` → `#### Validation Rules`, em `class-validator`, sem `@ApiProperty` manual (per `openapi-docs-nestjs/TD-01` e `.claude/rules/nestjs-dtos.md`).
3. Implementar `VideosService.initiateUpload()`: validar `declared_mime` contra o allowlist e `declared_size_bytes` contra o teto, lançando as domain exceptions de `UNSUPPORTED_VIDEO_FORMAT` e `VIDEO_TOO_LARGE`; gerar o slug via `VideoSlugService`; persistir a linha em `uploading`/`draft` com o `upload_id` devolvido pelo storage.
4. Calcular o particionamento e devolver uma URL pré-assinada por parte — tamanho de parte com piso de 5 MiB (limite do protocolo) e escolhido de modo que a contagem de partes não exceda 10 000.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: rejeita mime fora do allowlist e tamanho acima do teto (repo e storage mockados) | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration com banco e MinIO reais: linha criada em `uploading`/`draft` com `upload_id` gravado e multipart aberto no storage | `src/videos/videos.service.integration-spec.ts` |
| `accepted-video-formats.ts` | Unit: allowlist e teto expostos como fonte única | `src/videos/constants/accepted-video-formats.spec.ts` |

**Dependencies:** SI-03.2 (storage) + SI-03.3 (entidade) + SI-03.4 (slug).

**Acceptance criteria:**

- Iniciar upload com `declared_mime` fora do allowlist não cria linha alguma na tabela `videos`.
- Iniciar upload válido cria exatamente uma linha com `processing_status = uploading`, `visibility = draft` e `upload_id` não nulo.
- A resposta traz uma URL pré-assinada por parte, e a contagem de partes cobre integralmente o `declared_size_bytes` informado.
- Nenhuma URL pré-assinada devolvida aponta para o nome de serviço do Compose.
- O tamanho de parte devolvido nunca é inferior a 5 MiB.

---

### SI-03.7 — Endpoint `POST /videos`

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-initiate-upload.plan.md`
**Authorization:** Owner (autenticado; cria sob o próprio canal) — per `### Authorization Matrix`

**Description:** Expor a iniciação de upload por HTTP, com o contrato e os erros já fixados nas Technical Specifications.

**Technical actions:**

1. Criar `src/videos/videos.controller.ts` com o handler `POST /videos` recebendo `InitiateUploadDto` e devolvendo a resposta `201` exatamente como em `### API Contracts` → `#### POST /videos`.
2. Resolver o canal do usuário autenticado a partir do token e usá-lo como `channel_id` — o handler nunca aceita `channel_id` do corpo da requisição.
3. Anotar o handler com `@ApiOperation`, `@ApiResponse` por status code (201, 400, 401) referenciando `ApiErrorEnvelope` via `getSchemaPath()`, e `@ApiBearerAuth('access-token')` (per `openapi-docs-nestjs/TD-01` revision e `.claude/rules/nestjs-controllers.md`).
4. Registrar `VideosController` no `VideosModule` e o `VideosModule` no `AppModule`.

**Tests:** _(empty — controller é E2E-only por `testing-guide-nestjs-project`; os cenários E2E são autorados por `/plan-test-specs` e referenciados em **Test Specs:**)_

**Dependencies:** SI-03.6 — o handler delega ao serviço de iniciação.

**Acceptance criteria:**

- `POST /videos` sem `Authorization` retorna `401`.
- `POST /videos` com corpo válido retorna `201` com `id`, `slug`, `upload_id`, `part_size_bytes`, `parts` e `expires_in`.
- `POST /videos` com `declared_mime` fora do allowlist retorna `400` com `error: "UNSUPPORTED_VIDEO_FORMAT"`.
- `POST /videos` com `declared_size_bytes` acima de 10 GiB retorna `400` com `error: "VIDEO_TOO_LARGE"`.
- `POST /videos` com corpo faltando campo obrigatório retorna `400` de validação, no envelope `{ statusCode, error, message }`.
- Informar `channel_id` no corpo não altera o dono do vídeo criado — o canal vem sempre do token.

---

### SI-03.8 — Conclusão do upload e enfileiramento pós-commit

**Description:** Fechar o multipart com os `ETag` coletados pelo cliente, mover o vídeo para `processing` e enfileirar o job **depois** do commit — a ordem que evita o worker buscar uma linha que ainda não existe.

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` validando o array `parts` conforme `#### Validation Rules`.
2. Implementar `VideosService.completeUpload()`: recusar quando `processing_status` não é `uploading` (`INVALID_UPLOAD_STATE`); chamar `completeMultipartUpload` no storage e mapear recusa do storage para `INVALID_UPLOAD_PARTS`; dentro de uma transação, mover para `processing`, limpar `upload_id` e gravar o `size_bytes` real observado.
3. Enfileirar `process-video` com payload `{ videoId }` **após** o commit da transação — nunca dentro dela (per `phase-03-videos/TD-08`).
4. Implementar o caminho de abandono: `abortMultipartUpload` no storage quando a conclusão falha de forma irrecuperável. O que escapar deste caminho — cliente que some sem chamar a conclusão — é recolhido pela varredura do SI-03.16, que é a rede de segurança (per `phase-03-videos/TD-03` revision).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: recusa estado inválido; mapeia recusa do storage para o erro de partes (repo, storage e fila mockados) | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration com banco, MinIO e Redis reais: objeto íntegro no bucket, linha em `processing`, `upload_id` limpo e job presente na fila | `src/videos/videos.service.integration-spec.ts` |
| ordem commit → enqueue | Integration: o job só existe na fila depois de a transação ter comitado | `src/videos/video-enqueue-order.integration-spec.ts` |

**Dependencies:** SI-03.5 (fila registrada) + SI-03.6 (a linha em `uploading` e o `upload_id` vêm da iniciação).

**Acceptance criteria:**

- Concluir upload de um vídeo que não está em `uploading` não altera o registro e sinaliza `INVALID_UPLOAD_STATE`.
- Concluir com um `ETag` divergente não marca o vídeo como `processing` e sinaliza `INVALID_UPLOAD_PARTS`.
- Concluir com sucesso deixa o objeto `{id}/source` íntegro no bucket de vídeos e a linha em `processing` com `upload_id` nulo.
- O job `process-video` existe na fila somente após o commit — um observador que leia a fila antes do commit não encontra o job.
- Uma conclusão que falha de forma irrecuperável não deixa multipart aberto acumulando partes órfãs.

---

### SI-03.9 — Endpoint `POST /videos/:id/complete`

**Route:** POST /videos/:id/complete
**Test Specs:** see `nestjs-project/specs/videos-complete-upload.plan.md`
**Authorization:** Owner — per `### Authorization Matrix`

**Description:** Expor a conclusão do upload por HTTP, devolvendo `202` porque o processamento continua em segundo plano.

**Technical actions:**

1. Acrescentar o handler `POST /videos/:id/complete` ao `VideosController`, recebendo `CompleteUploadDto` e devolvendo `202` conforme `### API Contracts` → `#### POST /videos/:id/complete`.
2. Aplicar a verificação de propriedade antes de qualquer efeito: vídeo de outro canal responde `404 VIDEO_NOT_FOUND`, nunca `403` — um `403` confirmaria a existência do recurso (per `### Authorization Matrix`).
3. Anotar com `@ApiOperation`, `@ApiResponse` por status code (202, 400, 401, 404, 409) referenciando `ApiErrorEnvelope`, e `@ApiBearerAuth('access-token')`.

**Tests:** _(empty — controller é E2E-only por `testing-guide-nestjs-project`; os cenários E2E são autorados por `/plan-test-specs` e referenciados em **Test Specs:**)_

**Dependencies:** SI-03.7 (o controller já existe) + SI-03.8 (delega ao serviço de conclusão).

**Acceptance criteria:**

- `POST /videos/:id/complete` sem `Authorization` retorna `401`.
- Concluir o upload de um vídeo de outro canal retorna `404` com `error: "VIDEO_NOT_FOUND"` e não altera aquele vídeo.
- Concluir upload próprio válido retorna `202` com `processing_status: "processing"`.
- Concluir duas vezes o mesmo upload: a segunda chamada retorna `409` com `error: "INVALID_UPLOAD_STATE"`.
- `:id` que não é uuid retorna `400` de validação.

---

### SI-03.10 — Worker: serviço no Compose, Dockerfile com FFmpeg e bootstrap

**Description:** Colocar o worker em container próprio sobre a mesma base de código, com os binários que ele e a suíte de testes precisam.

**Technical actions:**

1. Criar `nestjs-project/Dockerfile.worker` instalando `ffmpeg` e `ffprobe` sobre a mesma imagem base da API, mantendo o padrão de criar `node_modules` com dono `node` antes do `USER node` (per `nestjs-test-infrastructure/TD-01`).
2. Acrescentar `ffmpeg` e `ffprobe` **também** ao `Dockerfile.dev` da API — a suíte roda no container `nestjs-api` e a política de external systems proíbe mockar o que o Compose roda de verdade (per `phase-03-videos/TD-04` revision).
3. Acrescentar o serviço `video-worker` ao `compose.yaml`, com o mesmo bind mount e o mesmo volume nomeado de `node_modules` da API, dependendo de `db`, `redis` e `minio`.
4. Criar o entrypoint do worker (`src/worker.ts`) inicializando um application context do Nest sem servidor HTTP, importando o módulo do processador.
5. Documentar o novo serviço no `nestjs-project/CLAUDE.md` (§ Development Environment e § Commands) — documentação que não acompanha o código é inconsistência de entrega.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| entrypoint do worker | Unit: compilation test do módulo do worker | `src/videos/processors/video-processing.module.spec.ts` |

**Dependencies:** SI-03.5 — o worker consome a fila registrada.

**Acceptance criteria:**

- `docker compose ps` mostra `video-worker` com status `running`.
- `docker compose exec video-worker ffprobe -version` e `ffmpeg -version` respondem com versão.
- `docker compose exec nestjs-api ffprobe -version` também responde — o binário existe onde a suíte roda.
- O worker sobe sem expor porta HTTP alguma.
- Derrubar e subir o worker não recria o volume de `node_modules` nem exige reinstalar dependências.

---

### SI-03.11 — Processador de vídeo: metadados, thumbnail e classificação de falha

**Description:** O handler do job — extrai metadados, gera a thumbnail e decide, em cada falha, se ela merece nova tentativa ou encerra o vídeo em `failed`.

**Technical actions:**

1. Criar `src/videos/processors/ffprobe.adapter.ts` e `ffmpeg.adapter.ts` invocando os binários com `execFile` e array de argumentos — **nunca** `exec` com string interpolada, porque nome de arquivo vindo do usuário em linha de comando é vetor de injeção (per `phase-03-videos/TD-05`).
2. Criar `src/videos/processors/video-processing.processor.ts` com `@Processor('video-processing')` estendendo `WorkerHost`, abrindo o `process()` com a **guarda de idempotência**: relê o vídeo e retorna sem efeito se já está `ready` ou `failed` (per `phase-03-videos/TD-08`).
3. Implementar a verificação de aceitação: `format_name` compatível com o allowlist de `accepted-video-formats.ts` **e** ao menos um stream de vídeo; falhar qualquer uma lança `UnrecoverableError` do `bullmq`, que move o job para o set `failed` ignorando `attempts`, e grava `processing_status = failed` com o `failure_reason` correspondente (per `phase-03-videos/TD-09`).
4. Persistir os oito campos de metadados de `### Data Model` a partir da saída de `ffprobe -print_format json`, gerar `{id}/default.jpg` no bucket privado de thumbnails e marcar `ready`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfprobeAdapter` / `FfmpegAdapter` | Integration com binário real: extrai metadados de um mp4 e de um webm de fixture; gera thumbnail legível | `src/videos/processors/ffprobe.adapter.integration-spec.ts` |
| `VideoProcessingProcessor` | Unit: guarda de idempotência; classificação transitória vs permanente (adapters e repo mockados) | `src/videos/processors/video-processing.processor.spec.ts` |
| `VideoProcessingProcessor` | Integration com banco, MinIO e Redis reais: vídeo válido termina `ready` com metadados e thumbnail; arquivo sem stream de vídeo termina `failed` sem consumir tentativas | `src/videos/processors/video-processing.processor.integration-spec.ts` |

**Dependencies:** SI-03.8 (o job só existe depois da conclusão) + SI-03.10 (o processador roda no container com os binários).

**Acceptance criteria:**

- Um mp4 válido termina com `processing_status = ready`, os oito campos de metadados preenchidos e o objeto `{id}/default.jpg` presente no bucket de thumbnails.
- Um webm válido percorre o mesmo caminho com sucesso — o allowlist aceita os dois contêineres.
- Um arquivo cujo contêiner está fora do allowlist termina `failed` com `failure_reason` preenchido, sem ter consumido tentativas de retry.
- Um arquivo sem stream de vídeo termina `failed` pelo mesmo caminho permanente.
- Processar o mesmo job duas vezes não duplica thumbnail nem sobrescreve metadados de um vídeo já `ready`.
- Uma falha transitória (storage momentaneamente indisponível) deixa o vídeo fora de `failed` e o job volta para a fila com atraso.
- O nome do arquivo original nunca é interpolado em string de shell — um nome contendo `;` ou `$()` não altera o comando executado.

---

### SI-03.12 — Serviço de entrega: URLs pré-assinadas com checagem de dono

**Description:** Resolver slug → vídeo, aplicar a política de acesso e emitir a URL pré-assinada de `GET` — mantendo o byte fora da API também na saída.

**Technical actions:**

1. Implementar `VideosService.findOwnBySlug()` — resolve por `slug` **e** canal do usuário na mesma consulta, para que vídeo de outro dono seja indistinguível de inexistente (`VIDEO_NOT_FOUND`).
2. Implementar `VideosService.buildStreamUrl()` e `buildDownloadUrl()`: recusar `processing_status` em `uploading`/`processing` (`VIDEO_NOT_READY`) e `failed` (`VIDEO_PROCESSING_FAILED`); assinar `GET` sobre `{id}/source` com expiração curta em minutos, e no caso de download acrescentar o override de `Content-Disposition: attachment` com o `original_filename` (per `phase-03-videos/TD-07`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findOwnBySlug` | Unit: mesmo resultado para slug inexistente e slug de outro canal (repo mockado) | `src/videos/videos.service.spec.ts` |
| `buildStreamUrl` / `buildDownloadUrl` | Unit: recusa por estado; expiração curta aplicada; override de disposition só no download | `src/videos/videos.service.spec.ts` |
| entrega ponta a ponta | Integration com MinIO real: a URL assinada devolve o objeto e honra `Range` com `206`; a de download vem com `Content-Disposition: attachment` | `src/videos/video-delivery.integration-spec.ts` |

**Dependencies:** SI-03.11 — só vídeo `ready` é entregável, e é o processador que marca `ready`.

**Acceptance criteria:**

- Buscar vídeo por slug de outro canal produz o mesmo resultado que slug inexistente — nenhuma diferença observável.
- Pedir entrega de vídeo em `processing` sinaliza `VIDEO_NOT_READY`; em `failed`, `VIDEO_PROCESSING_FAILED`.
- A URL de streaming devolve o objeto com `206` quando a requisição traz `Range`, sem a API intermediar bytes.
- A URL de download devolve `Content-Disposition: attachment` com o nome original do arquivo.
- Uma URL assinada usada após a expiração é recusada pelo storage.

---

### SI-03.13 — Endpoints de leitura e entrega

**Route:** GET /videos/:slug · GET /videos/:slug/stream · GET /videos/:slug/download
**Test Specs:** see `nestjs-project/specs/videos-delivery.plan.md`
**Authorization:** Owner nas três rotas — per `### Authorization Matrix`

**Description:** Expor a leitura do próprio vídeo e as duas rotas de entrega, ambas por `302` para URL pré-assinada.

**Technical actions:**

1. Acrescentar `GET /videos/:slug` ao `VideosController` devolvendo o corpo de `### API Contracts` → `#### GET /videos/:slug` — é o complemento observável do `202`, sem o qual o cliente não sabe que o processamento terminou.
2. Acrescentar `GET /videos/:slug/stream` e `GET /videos/:slug/download` emitindo `302` com `Location` apontando para a URL pré-assinada; a API não faz proxy de bytes (per `phase-03-videos/TD-07`).
3. Anotar as três rotas com `@ApiOperation`, `@ApiResponse` por status code (200/302, 401, 404, 409) referenciando `ApiErrorEnvelope`, e `@ApiBearerAuth('access-token')`.

**Tests:** _(empty — controller é E2E-only por `testing-guide-nestjs-project`; os cenários E2E são autorados por `/plan-test-specs` e referenciados em **Test Specs:**)_

**Dependencies:** SI-03.12 (delega ao serviço de entrega) + SI-03.9 (o controller já tem as rotas de upload).

**Acceptance criteria:**

- As três rotas sem `Authorization` retornam `401`.
- `GET /videos/:slug` de vídeo próprio retorna `200` com `processing_status` e os campos de metadados (nulos enquanto não processado).
- `GET /videos/:slug` de vídeo de outro canal retorna `404` com `error: "VIDEO_NOT_FOUND"`.
- `GET /videos/:slug/stream` de vídeo `ready` retorna `302` com `Location` para URL pré-assinada; seguir o `Location` entrega o vídeo.
- `GET /videos/:slug/stream` de vídeo em `processing` retorna `409` com `error: "VIDEO_NOT_READY"`.
- `GET /videos/:slug/download` de vídeo `ready` retorna `302`, e seguir o `Location` entrega o arquivo como anexo.
- Nenhuma resposta das três rotas contém bytes do vídeo — apenas metadados ou o redirect.

---

### SI-03.14 — Quality gates do worker

**Description:** Trazer o serviço novo para dentro da Definition of Done executável — um subprojeto que não está nos gates não é verificado por ninguém.

**Technical actions:**

1. Usar a skill `gate-builder` para acrescentar os gate ids do `video-worker` a `scripts/run-gate.mjs`, seguindo os ids estáveis e a ordem do mais barato ao mais caro; não editar o orquestrador à mão (per `phase-03-videos/TD-04`).
2. Atualizar `GATES.md` com os ids novos e o escopo de cada um.

**Tests:** _(empty — Infra: o próprio gate é o mecanismo de verificação)_

**Dependencies:** SI-03.10 — os gates apontam para o container do worker, que precisa existir.

**Acceptance criteria:**

- `node scripts/run-gate.mjs` executa os gates do worker além dos já existentes e sai com código 0.
- `node scripts/run-gate.mjs backend` continua funcionando com o escopo por subprojeto.
- Um gate do worker que falha faz o comando sair com código diferente de 0 e parar no primeiro erro.
- `GATES.md` lista todos os ids que o script executa, sem id órfão em nenhuma direção.

---

### SI-03.15 — OpenAPI: decoradores explícitos e refresh do spec commitado

**Description:** Fechar a obrigação permanente de que toda fase que altera a superfície HTTP regera e commita o `openapi.json` — sem isso o contrato versionado passa a descrever uma API que não existe mais.

**Technical actions:**

1. Revisar as cinco rotas da fase garantindo `@ApiOperation`, `@ApiResponse` por status code com schema, `@ApiBearerAuth('access-token')` e erros referenciando `ApiErrorEnvelope` via `getSchemaPath()` — o CLI plugin cobre só a inferência de schema dos DTOs de request (per `openapi-docs-nestjs/TD-01` revision).
2. Rodar `docker compose exec nestjs-api npm run openapi:export` e commitar o `nestjs-project/openapi.json` regerado (per `openapi-docs-nestjs/TD-02` revision).
3. Atualizar o `CLAUDE.md` da raiz e o `README.md` com o módulo de vídeos, as cinco rotas, os serviços novos do Compose (`redis`, `minio`, `video-worker`) e o storage.

**Tests:** _(empty — o artefato regerado e a consistência da documentação são o entregável; verificados pelos Acceptance criteria)_

**Dependencies:** SI-03.13 — todas as rotas precisam existir antes de gerar o spec.

**Acceptance criteria:**

- O `openapi.json` commitado contém as cinco rotas da fase, cada uma com os status codes documentados nas Technical Specifications.
- Cada resposta de erro no spec referencia o schema do envelope compartilhado, não um shape inline.
- Regerar o spec com a árvore limpa não produz diff — o arquivo commitado está em dia com o código.
- O Swagger UI em `/api/docs` (com `SWAGGER_ENABLED=true`) lista as rotas de vídeo com o botão Authorize.
- O `CLAUDE.md` e o `README.md` não citam arquivo, serviço ou comando inexistente.

---

### SI-03.16 — Varredura de multipart abandonado

**Description:** Recolher os uploads multipart que o cliente iniciou e nunca concluiu, para que suas partes não fiquem ocupando storage de forma invisível. É a rede de segurança que a `phase-03-videos/TD-03` exigia e que originalmente seria uma lifecycle rule do bucket — mecanismo que o MinIO desta fase não implementa.

**Technical actions:**

1. Criar `src/videos/abandoned-upload-sweeper.service.ts` no container do worker: lista os multipart em curso do bucket de vídeos via `listMultipartUploads` (SI-03.2, ação 5) e chama `abortMultipartUpload` (SI-03.2, ação 3) em cada um cuja iniciação tenha **ao menos 24 horas** (per `phase-03-videos/TD-03` revision).
2. Registrar a varredura como job repetível **horário** da fila BullMQ já criada no SI-03.5 — a TD-01 escolheu BullMQ justamente para que agendamento fosse configuração, não implementação; nenhum agendador novo entra no projeto.
3. Extrair o limiar de 24h e a cadência horária para constantes nomeadas em `src/videos/`, ao lado do allowlist da TD-09 — mesmo princípio de uma constante com consumidores explícitos.
4. Registrar em log cada abort executado, com o `uploadId` e a idade do upload; a varredura é destrutiva e precisa deixar rastro auditável.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `AbandonedUploadSweeperService` | Unit: seleção por idade — aborta o que passou de 24h, preserva o que não passou (relógio injetado/fake) | `src/videos/abandoned-upload-sweeper.service.spec.ts` |
| `AbandonedUploadSweeperService` | Integration com MinIO real: um multipart iniciado agora sobrevive à varredura; um com iniciação forjada além do limiar é abortado e some do `listMultipartUploads` | `src/videos/abandoned-upload-sweeper.service.integration-spec.ts` |

**Dependencies:** SI-03.10 — a varredura roda no container do worker, que só existe a partir dali; e SI-03.2, de onde vêm `listMultipartUploads` e `abortMultipartUpload`.

**Acceptance criteria:**

- Um multipart iniciado há menos de 24 horas **não** é abortado pela varredura — é o caso que protege upload de 10GB ainda em curso num link lento.
- Um multipart cuja iniciação passou de 24 horas é abortado, e deixa de aparecer no `listMultipartUploads` seguinte.
- A varredura está registrada como job repetível horário na fila do SI-03.5 — não há agendador próprio, nem `setInterval` solto no processo.
- O limiar e a cadência são constantes nomeadas, não literais espalhados pelo código.
- Cada abort produz uma linha de log identificando o `uploadId` e a idade do upload recolhido.

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| channel_id | uuid | FK → `channels.id`, not null, on delete cascade |
| slug | varchar(16) | unique, not null — short random public identifier (per `phase-03-videos/TD-06`) |
| title | varchar(255) | not null — display name; optional at initiation, derived from `original_filename` when absent (see the note below) |
| original_filename | varchar(255) | not null — declared by the client at upload initiation (per `phase-03-videos/TD-09`) |
| declared_mime | varchar(100) | not null — declared at initiation, validated against the allowlist (per `phase-03-videos/TD-09`) |
| declared_size_bytes | bigint | not null — declared at initiation, validated against the 10GB ceiling (per `phase-03-videos/TD-09`) |
| processing_status | enum `videos_processing_status_enum` | not null, default `uploading` (per `phase-03-videos/TD-08`) |
| visibility | enum `videos_visibility_enum` | not null, default `draft` (per `phase-03-videos/TD-08` revision) |
| upload_id | varchar(255) | nullable — the storage multipart `UploadId`, cleared on completion or abort (per `phase-03-videos/TD-03`) |
| duration_seconds | integer | nullable — written by the worker (per `phase-03-videos/TD-05` revision) |
| width | integer | nullable — written by the worker |
| height | integer | nullable — written by the worker |
| video_codec | varchar(50) | nullable — written by the worker |
| audio_codec | varchar(50) | nullable — written by the worker |
| format_name | varchar(100) | nullable — `ffprobe` container name; also carries the container the object key no longer encodes (per `phase-03-videos/TD-02` revision) |
| size_bytes | bigint | nullable — real size observed after upload, compared against `declared_size_bytes` |
| bitrate | integer | nullable — written by the worker |
| failure_reason | varchar(100) | nullable — which permanent-failure condition fired (per `phase-03-videos/TD-09`: container outside allowlist, or no video stream) |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), on update |

**Relations:** `Channel` has many `Video` (one-to-many). Ownership resolves through the channel — Phase 02 creates exactly one channel per user, so channel ownership and user ownership are equivalent today; the FK points at `channels` because Fase 04 manages videos alongside the channel.

**Indexes:** unique on `slug`; index on `channel_id`; index on `processing_status` (per `phase-03-videos/TD-08` — Fase 04 lists videos by status via SQL).

**Enum types:**

- `videos_processing_status_enum`: `uploading`, `processing`, `ready`, `failed` (per `phase-03-videos/TD-08`).
- `videos_visibility_enum`: `draft`, `published`. Only `draft` is reachable in this phase — no publication transition ships here (per `phase-03-videos/TD-08` revision); `published` is declared because `phase-03-videos/TD-07`'s revision names it as the value the later phases gate on. `unlisted` is Fase 04's addition (per `phase-03-videos/TD-07`).

**Storage keys (not columns — derived from `id`, per `phase-03-videos/TD-02` and its revision):**

- Video object: `{id}/source` in the private bucket `streamtube-videos` — **no extension**; the container lives in `format_name` and in the object's stored `Content-Type`.
- Thumbnail object: `{id}/default.jpg` in the bucket `streamtube-thumbnails`, **private in this phase** (per `phase-03-videos/TD-02` revision).

**`title` — added after the original plan, on 2026-07-28.** The first version of this Data Model left it out, arguing that editable video metadata belongs to Fase 04 and that adding it here would be scope not traceable to a Phase 03 capability. That argument was built on the capability list in `project-plan.md` alone. The challenge statement names `título` explicitly among the minimum persistence fields — *"uma entidade/tabela de vídeos ligada ao canal, com pelo menos identificação, dono (canal), **título**, status, chaves de storage do arquivo e do thumbnail, duração e metadados, e o identificador da URL única"* — so the field does have an identifiable origin, and the omission was a gap rather than a scoping decision.

Kept minimal on purpose: the column is written once, at upload initiation. It is **optional in the request** — the capability in scope is the *automatic* pre-registration of the draft, so a client holding only a file must still be able to start an upload; the title is then derived from `original_filename` minus its extension, falling back to `video`. Editing it after the fact remains Fase 04's *Gerenciamento de Vídeos e Canal*, and no update endpoint ships here.

**Still deliberately absent:** `description`. Nothing in the scope or in the challenge statement names it.

**Migration note:** migrations are immutable and `synchronize` is never used (`.claude/rules/typeorm-migrations.md`, inherited). Both enum types are independent Postgres objects — integration tests that drop tables must drop the enum types explicitly and register them in `MANAGED_ENUM_TYPES` (`nestjs-project/CLAUDE.md` § Test Database).

### API Contracts

Todos os endpoints ficam sob o `JwtAuthGuard` global, sem `@Public()` (per `phase-03-videos/TD-07` revision). O envelope de erro é o herdado de `phase-02-auth/TD-07`: `{ statusCode, error, message }`, onde `error` carrega o código de domínio do `### Error Catalog`. Cada handler recebe decoradores explícitos `@ApiOperation` / `@ApiResponse` / `@ApiBearerAuth('access-token')` e o `openapi.json` é regerado e commitado (per `openapi-docs-nestjs/TD-01` revision + `openapi-docs-nestjs/TD-02` revision).

#### POST /videos (SI-03.7)

Inicia o upload: cria a linha em `draft`/`uploading`, valida a declaração, abre o multipart no storage e devolve uma URL pré-assinada por parte. O byte nunca passa pela API (per `phase-03-videos/TD-03`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- title: string, optional — max 255; derived from `original_filename` when absent (see `#### Video` → `**title**`)
- original_filename: string, required — max 255
- declared_mime: string, required — must be `video/mp4` or `video/webm` (per `phase-03-videos/TD-09`)
- declared_size_bytes: integer, required — > 0 and ≤ 10737418240 (10 GiB) (per `phase-03-videos/TD-09`)

**Response 201:**
- id: string (uuid)
- slug: string
- upload_id: string — the storage multipart `UploadId`
- part_size_bytes: integer — server-chosen part size
- parts: array of `{ part_number: integer, url: string }` — one presigned `UploadPart` URL per part (per `phase-03-videos/TD-10`)
- expires_in: integer — seconds until the part URLs expire

**Error responses:**
- 400 UNSUPPORTED_VIDEO_FORMAT: `declared_mime` outside the allowlist
- 400 VIDEO_TOO_LARGE: `declared_size_bytes` above the 10 GiB ceiling
- 400 validation error: request body fails schema validation
- 401 (no/invalid access token)

---

#### POST /videos/:id/complete (SI-03.9)

Fecha o multipart com os `ETag` que o cliente coletou, marca `processing` e enfileira o job **depois** do commit da transação (per `phase-03-videos/TD-08`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- parts: array of `{ part_number: integer, etag: string }`, required — non-empty, one entry per uploaded part

**Response 202:**
- id: string (uuid)
- slug: string
- processing_status: string — `processing`

**Error responses:**
- 404 VIDEO_NOT_FOUND: id does not exist or belongs to another channel
- 409 INVALID_UPLOAD_STATE: `processing_status` is not `uploading`
- 409 INVALID_UPLOAD_PARTS: storage rejected the part set (missing part or `ETag` mismatch)
- 400 validation error
- 401 (no/invalid access token)

---

#### GET /videos/:slug (SI-03.13)

Leitura do próprio vídeo — é o complemento observável do `202` acima: sem ele o cliente não tem como saber que o processamento terminou. Listagem de vídeos por status é Fase 04.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- id: string (uuid)
- slug: string
- title: string
- original_filename: string
- processing_status: string — `uploading` | `processing` | `ready` | `failed`
- visibility: string — `draft`
- duration_seconds: integer | null
- width: integer | null
- height: integer | null
- video_codec: string | null
- audio_codec: string | null
- format_name: string | null
- size_bytes: integer | null
- bitrate: integer | null
- failure_reason: string | null
- created_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug does not exist or belongs to another channel
- 401 (no/invalid access token)

---

#### GET /videos/:slug/stream (SI-03.13)

Emite `302` para uma URL pré-assinada de `GET` no storage. `Range`/`206` fica com o S3/MinIO — a API não intermedia bytes (per `phase-03-videos/TD-07`). A URL é assinada com o endpoint **público** do storage, não com o nome de serviço do Compose (per `phase-03-videos/TD-10`).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 302:**
- Location: presigned `GET` URL for `{id}/source`, short expiry in minutes (per `phase-03-videos/TD-07`)

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug does not exist or belongs to another channel
- 409 VIDEO_NOT_READY: `processing_status` is `uploading` or `processing`
- 409 VIDEO_PROCESSING_FAILED: `processing_status` is `failed`
- 401 (no/invalid access token)

---

#### GET /videos/:slug/download (SI-03.13)

Mesmo mecanismo do streaming, com a URL pré-assinada carregando o override de `Content-Disposition: attachment` para o storage devolver como download.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 302:**
- Location: presigned `GET` URL for `{id}/source` with a `Content-Disposition: attachment; filename="{original_filename}"` response override

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug does not exist or belongs to another channel
- 409 VIDEO_NOT_READY: `processing_status` is `uploading` or `processing`
- 409 VIDEO_PROCESSING_FAILED: `processing_status` is `failed`
- 401 (no/invalid access token)

---

**Sem endpoint de thumbnail nesta fase.** A capability em escopo é *geração* de thumbnail, não entrega. O objeto fica no bucket privado e o acesso exige URL pré-assinada emitida pelo mesmo caminho com checagem de dono (per `phase-03-videos/TD-02` revision); a fase que expor a thumbnail (04/05) acrescenta a rota reusando esse gate.

#### Validation Rules — upload initiation e completion

- `title`: optional, string, max 255, non-empty when present. Absent or blank falls back to the filename-derived value.
- `original_filename`: required, string, max 255.
- `declared_mime`: required, string, ∈ { `video/mp4`, `video/webm` } — allowlist único importado pela API e pelo worker de um módulo em `src/videos/` (per `phase-03-videos/TD-09`).
- `declared_size_bytes`: required, integer, > 0, ≤ 10737418240.
- `parts`: required, array, min 1; cada item com `part_number` integer ≥ 1 e `etag` string não-vazia.
- `:id`: uuid válido; `:slug`: string no formato gerado pela TD-06.
- Validação por `class-validator` + `class-transformer`, com o `ValidationPipe` global já em vigor (per `phase-02-auth/TD-06`, herdado). DTOs de request não recebem `@ApiProperty` manual — o CLI plugin do Swagger infere dos decoradores de validação (per `openapi-docs-nestjs/TD-01` e `.claude/rules/nestjs-dtos.md`).

### Authorization Matrix

Nesta fase todo vídeo nasce e permanece `visibility = draft`, e a transição de publicação pertence à Fase 04 — logo não existe vídeo publicado para servir a anônimo, e abrir qualquer rota exporia rascunho de terceiro (per `phase-03-videos/TD-07` revision). "Owner" = o usuário autenticado cujo canal é dono do vídeo.

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ | ✓ (cria sob o próprio canal) | ✓ |
| POST /videos/:id/complete | ✗ | ✗ | ✓ |
| GET /videos/:slug | ✗ | ✗ | ✓ |
| GET /videos/:slug/stream | ✗ | ✗ | ✓ |
| GET /videos/:slug/download | ✗ | ✗ | ✓ |

**Non-owner devolve `404 VIDEO_NOT_FOUND`, não `403`** — um `403` confirmaria a existência do recurso e permitiria enumeração de slugs de terceiros. A distinção "não existe" vs "não é seu" não é observável pelo cliente.

**Objeto de thumbnail (sem endpoint nesta fase):** o bucket `streamtube-thumbnails` é privado (per `phase-03-videos/TD-02` revision), então o objeto não é alcançável por URL direta. Quando uma fase posterior o expor, o acesso passa pelo mesmo gate de dono das rotas acima.

**Buckets:** `streamtube-videos` e `streamtube-thumbnails` são ambos privados nesta fase — nenhuma política de bucket público é aplicada no bootstrap.

**Herança:** o `JwtAuthGuard` global com opt-out via `@Public()` vem da Fase 02; nenhum handler desta fase usa `@Public()`, e todos carregam `@ApiBearerAuth('access-token')` (per `.claude/rules/nestjs-controllers.md`).

### Error Catalog

O envelope é o herdado de `phase-02-auth/TD-07` — `{ statusCode, error, message }` — onde o campo `error` carrega o código de domínio abaixo. Serviços lançam domain exceptions; o filtro global mapeia para HTTP (`.claude/rules/nestjs-services.md`). As respostas de erro referenciam o DTO compartilhado `ApiErrorEnvelope` via `getSchemaPath()` (`.claude/rules/nestjs-controllers.md`).

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| UNSUPPORTED_VIDEO_FORMAT | 400 | `declared_mime` fora do allowlist `video/mp4` \| `video/webm` na iniciação (per `phase-03-videos/TD-09`) |
| VIDEO_TOO_LARGE | 400 | `declared_size_bytes` acima de 10 GiB na iniciação (per `phase-03-videos/TD-09`) |
| VIDEO_NOT_FOUND | 404 | `id`/`slug` inexistente **ou** pertencente a outro canal |
| INVALID_UPLOAD_STATE | 409 | `complete` chamado quando `processing_status` não é `uploading` (per `phase-03-videos/TD-08`) |
| INVALID_UPLOAD_PARTS | 409 | storage recusou o conjunto de partes no `CompleteMultipartUpload` — parte ausente ou `ETag` divergente |
| VIDEO_NOT_READY | 409 | `stream`/`download` com `processing_status` em `uploading` ou `processing` |
| VIDEO_PROCESSING_FAILED | 409 | `stream`/`download` com `processing_status` = `failed` |

**Falhas do worker não são erros HTTP.** O job classifica a falha e ela chega ao cliente pelo `processing_status`/`failure_reason` do `GET /videos/:slug`, não por status code — o upload já respondeu `202` quando o processamento começa. As duas condições permanentes da TD-09 (contêiner fora do allowlist verificado pelo `ffprobe`; ausência de stream de vídeo) gravam `failed` + `failure_reason` e **não** consomem tentativas — ver `### Events/Messages`.

### Events/Messages

Fila única, um tipo de job, um consumidor — BullMQ sobre Redis, com `@nestjs/bullmq` (per `phase-03-videos/TD-01`). O worker roda em container separado sobre a mesma base de código (per `phase-03-videos/TD-04`).

#### process-video

Queue: `video-processing`.

**Payload:**

```json
{ "videoId": "uuid" }
```

O payload é deliberadamente mínimo: o handler relê o estado do banco em vez de confiar em dados carregados no job. É a recomendação de idempotência do próprio BullMQ (jobs atômicos e simples) e elimina a classe de bug em que o job carrega um estado que já mudou.

**Producer:** `VideosService` (per `phase-03-videos/TD-08`) — enfileira em `POST /videos/:id/complete`, **depois** do commit da transação que move `processing_status` para `processing`. Enfileirar dentro da transação deixa o worker buscar uma linha que ainda não existe: condição de corrida clássica e difícil de reproduzir.

**Consumer:** `VideoProcessingProcessor` no serviço `video-worker` do Compose — classe com `@Processor('video-processing')` estendendo `WorkerHost` e implementando `process(job)` (per `phase-03-videos/TD-04` e `library-refs.md` → `@nestjs/bullmq`).

**Trigger:** conclusão do multipart upload, quando o objeto `{id}/source` já existe íntegro no storage.

**Delivery semantics:** at-least-once (per `phase-03-videos/TD-08`). O job só sai do set `active` quando `moveToFinished` conclui, e a detecção de stall reenfileira jobs de worker morto — por isso a guarda de idempotência abaixo é obrigatória, não defensiva.

**Handler steps (ordem fixada pela TD-05, TD-09 e TD-08):**

1. **Guarda de idempotência** no início: relê o vídeo; se `processing_status` já é `ready` ou `failed`, retorna sem efeito (per `phase-03-videos/TD-08`).
2. **`ffprobe -print_format json`** sobre o objeto, via `execFile` com array de argumentos — nunca `exec` com string interpolada, porque nome de arquivo vindo do usuário em linha de comando é vetor de injeção (per `phase-03-videos/TD-05`).
3. **Verificação de aceitação** (per `phase-03-videos/TD-09`): `format_name` compatível com o allowlist **e** existência de ao menos um stream de vídeo. Falhar qualquer uma → falha **permanente**.
4. **Persistir metadados**: `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `format_name`, `size_bytes`, `bitrate` (per `phase-03-videos/TD-05` revision).
5. **Gerar thumbnail** de um frame via `ffmpeg`, gravando `{id}/default.jpg` no bucket privado de thumbnails (per `phase-03-videos/TD-05` e `phase-03-videos/TD-02` revision).
6. **Marcar `ready`**.

**Retry e falha permanente:**

| Classe | Mecanismo | Efeito |
|---|---|---|
| Transitória (storage indisponível, timeout, erro de I/O) | `attempts` + `backoff: { type: 'exponential' }` | job volta para a fila com atraso crescente |
| **Permanente** (contêiner fora do allowlist; nenhum stream de vídeo) | lançar `UnrecoverableError` do `bullmq` | job vai direto para o set `failed` **ignorando `attempts`**; grava `processing_status = failed` + `failure_reason` |

O critério está em `Job.shouldRetryJob`: retenta se `attemptsMade + 1 < opts.attempts` **e** o erro não é `UnrecoverableError` — checado por `instanceof` **ou** por `err.name === 'UnrecoverableError'`, então subclasse própria funciona desde que preserve o `name` (verificado via context7, ver `library-refs.md`).

**Dead letter:** é o próprio set `failed` da fila, alcançado quando `shouldRetryJob` devolve `false` — não há fila separada nem infraestrutura adicional a provisionar (per `phase-03-videos/TD-08`).

**Encerramento:** o `onApplicationShutdown` registrado pelo módulo chama `worker.close()` e depois `queue.close()`. Testes de integração precisam fechar worker e queue em `finally`; o `--forceExit` dos scripts é rede de segurança, não substituto (per `nestjs-test-infrastructure/TD-03`, herdado).

---

## Dependency Map

```
SI-03.1 (root — Redis, MinIO e configs no Compose)
├── SI-03.2 — depends on SI-03.1 (endpoints e credenciais vêm da config namespaced)
│   └── SI-03.6 — depends on SI-03.2 + SI-03.3 + SI-03.4 (abre o multipart, persiste o rascunho, gera o slug)
│       ├── SI-03.7 — depends on SI-03.6 (endpoint delega ao serviço de iniciação)
│       │   └── SI-03.9 — depends on SI-03.7 + SI-03.8 (mesmo controller, delega ao serviço de conclusão)
│       │       └── SI-03.13 — depends on SI-03.12 + SI-03.9 (rotas de leitura e entrega no mesmo controller)
│       │           └── SI-03.15 — depends on SI-03.13 (spec só é regerado com todas as rotas no lugar)
│       └── SI-03.8 — depends on SI-03.5 + SI-03.6 (enfileira após o commit a linha aberta na iniciação)
│           └── SI-03.11 — depends on SI-03.8 + SI-03.10 (o job só existe após a conclusão; roda no container com FFmpeg)
│               └── SI-03.12 — depends on SI-03.11 (só vídeo `ready` é entregável)
└── SI-03.5 — depends on SI-03.1 (host e porta do Redis vêm de queue.config.ts)
    └── SI-03.10 — depends on SI-03.5 (o worker consome a fila registrada)
        ├── SI-03.14 — depends on SI-03.10 (os gates apontam para o container do worker)
        └── SI-03.16 — depends on SI-03.10 + SI-03.2 (varredura roda no worker, sobre as duas operações do storage)

SI-03.3 (root, independente — entidade, enums e migration)
└── SI-03.4 — depends on SI-03.3 (colisão de slug é checada contra o índice único)
```

Dois roots: **SI-03.1** (infraestrutura de fila e storage) e **SI-03.3** (modelo de dados) — não há dependência entre eles, então podem ser executados em qualquer ordem ou em paralelo. O caminho crítico é `SI-03.1 → SI-03.2 → SI-03.6 → SI-03.8 → SI-03.11 → SI-03.12 → SI-03.13 → SI-03.15`: oito passos, do Compose até o spec regerado.

**SI-03.6** é o ponto de convergência dos dois roots — é onde storage, entidade e slug se encontram pela primeira vez.

---

## Deliverables

- [x] SI-03.1 — Infra: Redis, MinIO e configuração de ambiente
- [x] SI-03.2 — Cliente S3: provedores, bootstrap de buckets e varredura de multipart
- [x] SI-03.3 — Entidade `Video`, enums e migration
- [x] SI-03.4 — Geração do identificador público único
- [x] SI-03.5 — Registro da fila BullMQ
- [x] SI-03.6 — Serviço de iniciação de upload
- [x] SI-03.7 — Endpoint `POST /videos`
- [x] SI-03.8 — Conclusão do upload e enfileiramento pós-commit
- [x] SI-03.9 — Endpoint `POST /videos/:id/complete`
- [x] SI-03.10 — Worker: serviço no Compose, Dockerfile com FFmpeg e bootstrap
- [x] SI-03.11 — Processador de vídeo: metadados, thumbnail e classificação de falha
- [x] SI-03.12 — Serviço de entrega: URLs pré-assinadas com checagem de dono
- [x] SI-03.13 — Endpoints de leitura e entrega
- [x] SI-03.14 — Quality gates do worker
- [x] SI-03.15 — OpenAPI: decoradores explícitos e refresh do spec commitado
- [x] SI-03.16 — Varredura de multipart abandonado

**Entregáveis da fase (`docs/project-plan.md`):**

- [x] Upload de até 10GB funcional — o byte vai do cliente ao storage por multipart pré-assinado, sem transitar pelo processo Node
- [x] Processamento automático do vídeo — duração e metadados extraídos e thumbnail gerada sem intervenção
- [x] Streaming funcionando — `302` para URL pré-assinada, com `Range`/`206` honrado pelo storage
- [x] URLs únicas geradas — slug curto com índice único e tratamento de colisão

**Infraestrutura real no Compose:**

- [x] `redis`, `minio` e `video-worker` sobem como serviços de verdade e são exercitados pelos testes de integração
- [x] `openapi.json` regerado e commitado, sem diff contra a árvore limpa
- [x] `CLAUDE.md` (raiz e `nestjs-project/`) e `README.md` descrevem o módulo de vídeos, as cinco rotas, os três serviços novos e o storage

**Full test suites:**

- [x] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [x] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [x] Type checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [x] Lint passes (`docker compose exec nestjs-api npm run lint`)

**Quality gates** _(the executable form of the Definition of Done — see `GATES.md`)_:

- [x] Quality gates pass (`node scripts/run-gate.mjs`) — rodado da raiz do repo, depois dos checks por subprojeto acima, e já incluindo os gate ids do `video-worker` adicionados em SI-03.14.
