---
libs:
  "bullmq":
    version: "5.81.2"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-27T01:49:24Z"
  "@nestjs/bullmq":
    version: "11.0.4"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-07-27T01:49:24Z"
  "@aws-sdk/client-s3":
    version: "3.1095.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-27T01:49:24Z"
  "@aws-sdk/s3-request-presigner":
    version: "3.1095.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-27T01:49:24Z"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-27T02:10:44Z"
---

# Library References — phase-03-videos

> Nenhuma destas bibliotecas está instalada ainda. O `nestjs-project/package.json` hoje tem NestJS 11, TypeORM 0.3.28, `@nestjs/swagger` 11.4.2, Joi 18.1.2, class-validator 0.14.4, TypeScript 5.7 e `@types/node` 22. As versões abaixo foram verificadas no registry npm em 2026-07-25; o **formato da API** foi confirmado via context7 em 2026-07-26/27. Se o `npm install` trouxer major diferente, sinalizar a divergência antes de implementar.
>
> FFmpeg e ffprobe (`phase-03-videos/TD-04`, `TD-05`) **não** aparecem aqui: são binários instalados pelo Dockerfile, não pacotes npm. A revisão de 2026-07-26 na TD-04 estendeu a instalação à imagem da API/dev, além da do worker.

## bullmq

_Fonte: `/taskforcesh/bullmq` · usada por `phase-03-videos/TD-01`, `TD-08`, `TD-09`_

**Retry com backoff exponencial** — configurado por job, não por worker:

```typescript
await queue.add('process-video', { videoId }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
});
```

**Falha permanente sem gastar tentativas** — é o mecanismo exato que a TD-08 pediu ("distinguir falha transitória de permanente") e que a TD-09 usa para input fora do allowlist. Lançar `UnrecoverableError` move o job direto para o set `failed`, **ignorando `attempts`**:

```typescript
import { Worker, UnrecoverableError } from 'bullmq';
// dentro do processor:
throw new UnrecoverableError('formato não suportado');
```

O critério está em `Job.shouldRetryJob`: retenta se `attemptsMade + 1 < opts.attempts` **e** o erro não é `UnrecoverableError` (checado por `instanceof` **ou** por `err.name == 'UnrecoverableError'` — subclasse própria funciona desde que preserve o `name`).

**Dead letter** — não é uma fila separada: é o set `failed` da própria fila, alcançado quando `shouldRetryJob` devolve `false`. Não há infraestrutura adicional a provisionar.

**Entrega at-least-once** — o job só sai do set `active` quando `moveToFinished` conclui; detecção de stall reenfileira jobs de worker que morreu. É a razão pela qual a guarda de idempotência da TD-08 é obrigatória, não defensiva.

**Idempotência (padrão oficial)** — a doc é explícita: o estado final do sistema deve ser o mesmo se o job completa na 1ª tentativa ou na 3ª. Recomenda jobs atômicos e simples, e dividir os complexos, justamente para que rollback parcial não seja necessário.

## @nestjs/bullmq

_Fonte: `/nestjs/bull` · usada por `phase-03-videos/TD-01`, `TD-04`_

**Registro do módulo** — a variante `forRootAsync` + `registerQueueAsync` com `useFactory` é a que se encaixa na convenção herdada do projeto (config namespaced via `registerAs` + injeção por `ConfigType`, ver `## Inherited Conventions`):

```typescript
BullModule.forRootAsync({
  useFactory: () => ({ connection: { host: 'redis', port: 6379 } }),
}),
BullModule.registerQueue({ name: 'video-processing' }),
```

O host do Redis é o nome do serviço do Compose (`redis`), como o `CLAUDE.md` exige.

**Processor** — classe decorada com `@Processor`, estendendo `WorkerHost` e implementando `process(job)`:

```typescript
@Processor('video-processing')
class VideoProcessor extends WorkerHost {
  async process(job: Job): Promise<void> { /* ... */ }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) { /* ... */ }
}
```

`WorkerHost.worker` só existe depois do hook `onModuleInit` — acessá-lo antes lança erro explícito. Relevante para o worker em container separado da TD-04: interagir com a instância a partir de `onApplicationBootstrap`, não do construtor.

**Produtor** — `@InjectQueue('video-processing')` injeta a `Queue`. É por aqui que a TD-08 enfileira o job **depois** do commit da transação.

**Encerramento** — o `onApplicationShutdown` registrado pelo módulo chama `worker.close()` para cada worker e depois `queue.close()`. Isso importa diretamente para os testes: `nestjs-test-infrastructure/TD-03` mantém `--forceExit` como rede de segurança mas exige `destroy()`/`app.close()` em `finally`; um worker que segura job ativo pode travar o shutdown, porque `close()` espera os jobs ativos terminarem.

## @aws-sdk/client-s3

_Fonte: `/aws/aws-sdk-js-v3` · usada por `phase-03-videos/TD-02`, `TD-03`, `TD-07`, `TD-10`_

**Cliente contra MinIO** — endpoint explícito mais `forcePathStyle`, que é o padrão documentado para storage S3-compatível:

```typescript
new S3Client({
  endpoint: 'http://minio:9000',
  forcePathStyle: true,
  region: 'us-east-1',
  credentials: { accessKeyId: '...', secretAccessKey: '...' },
});
```

Sem `forcePathStyle: true` o SDK monta URL virtual-hosted (`bucket.minio:9000`), que não resolve na rede do Compose. A TD-10 exige **duas configurações de endpoint**: a interna acima para operações servidor→storage, e uma pública (env própria) usada apenas para **assinar** URLs que o navegador consome.

**Multipart** — `CreateMultipartUploadCommand` devolve o `UploadId`; `UploadPartCommand` recebe `UploadId` + `PartNumber`; `CompleteMultipartUploadCommand` recebe `MultipartUpload: { Parts: [{ PartNumber, ETag }] }`. Os `ETag` de cada parte vêm da resposta do `UploadPart` — no fluxo pré-assinado da TD-03 quem os coleta é o **cliente**, e os devolve à API na chamada de conclusão.

**Lifecycle rule que a TD-03 exige** — `PutBucketLifecycleConfigurationCommand` com a regra de multipart abandonado:

```typescript
{ Status: 'Enabled', ID: 'abort-incomplete-multipart',
  AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }
```

**Atenção na implementação:** o SDK v3 tem `requestChecksumCalculation: "WHEN_SUPPORTED"` por default, o que adiciona checksum CRC32 às operações. Em request **pré-assinado** o cliente precisa enviar exatamente os headers que foram assinados — verificar esse comportamento contra o MinIO ao implementar, e ajustar a configuração se a assinatura divergir. Foi registrado como `Con` conhecido na Option A da TD-10.

## @aws-sdk/s3-request-presigner

_Fonte: `/aws/aws-sdk-js-v3` · usada por `phase-03-videos/TD-03`, `TD-07`, `TD-10`_

**Uma única função para os dois fluxos da fase.** `getSignedUrl(client, command, options)` assina qualquer command — é o que torna a Option A da TD-10 viável, porque `UploadPartCommand` (upload por parte) e `GetObjectCommand` (streaming/download) passam pelo mesmo caminho:

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), {
  expiresIn: 300,
});
```

**`expiresIn` é em segundos e o default é 900** (15 min). A TD-07 pede expiração curta — "minutos" — porque o controle de acesso vira janela temporal; fixar explicitamente em vez de herdar o default.

Para o presign de parte, o command é construído com `Bucket`, `Key`, `UploadId` e `PartNumber`, e cada parte recebe sua própria URL assinada.
