---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-07-25
scope_description: "Upload, armazenamento e processamento assíncrono de vídeos: tecnologia de fila, organização do object storage, protocolo de upload de até 10GB sem passar pela API, execução do worker de processamento (metadados + thumbnail via FFmpeg), identificador público único por vídeo, entrega por streaming/download e o ciclo de status com tratamento de falha."
---

# Technical Decisions — Fase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — subprojeto primário. Recebe o módulo de vídeos, a entidade/migration, o serviço de storage, o produtor da fila e o worker de processamento. Todas as TDs deste documento incidem aqui.
- `next-frontend/` — **sem decisão aberta nesta fase.** O enunciado da Fase 03 é explicitamente de backend ("a interface de vídeo não faz parte do escopo desta fase"), e nenhuma capability da fase no `project-plan.md` descreve tela ou componente. O contrato HTTP produzido aqui é publicado via `openapi.json` e consumido pelo frontend nas Fases 04–05, sob as decisões já fixadas em `next-frontend-openapi-typing/TD-01..TD-05`. Nenhum TD de Frontend é criado agora — seria extrapolação.

> Restrições herdadas (já decididas — não reabrir):
> - **Object storage não é escolha em aberto.** O `project-plan.md` e o `software-arch.mermaid` fixam S3-compatível, com MinIO local em Docker. O que se decide aqui é **como usá-lo** (buckets, chaves, upload pré-assinado), não qual é.
> - **Hosts sempre pelo nome do serviço do Compose** (`CLAUDE.md` § Docker Networking). Isso tem consequência direta e não óbvia no upload pré-assinado — ver TD-03.
> - **Migrations são imutáveis e `synchronize` nunca é usado** (`.claude/rules/typeorm-migrations.md`).
> - **Serviços lançam domain exceptions, nunca exceções HTTP do NestJS** (`.claude/rules/nestjs-services.md`); o filtro global mapeia para HTTP.
> - **Definition of Done é executável** via `node scripts/run-gate.mjs` (`GATES.md`). Um subprojeto novo (o worker) precisa entrar nos gate ids.
> - **Testes usam infra real do Compose** — não mockar o que sobe em container (`testing-guide-nestjs-project`).

> **Nota sobre a consulta de documentação:** o `CLAUDE.md` exige consulta via **context7 MCP** antes de implementar com qualquer biblioteca. Quando este documento foi escrito, o `.mcp.json` do projeto declarava apenas `postgres`, então as versões abaixo foram verificadas no registry npm e a documentação consultada nas fontes oficiais. **O context7 foi instalado em 2026-07-25** (`.mcp.json` → `@upstash/context7-mcp` 3.2.5, testado de ponta a ponta). **`/plan-resolve` deve confirmar cada biblioteca via context7** e registrar em `library-refs.md`; se a documentação divergir do que está aqui, a divergência precisa ser sinalizada antes de prosseguir.
>
> Ferramentas expostas pelo servidor (v3.2.5): `resolve-library-id` (exige **ambos** `libraryName` e `query`) e `query-docs` (exige `libraryId` e `query`). Library IDs já resolvidos para esta fase: **`/taskforcesh/bullmq`** e **`/nestjs/bull`**.

---

## TD-01: Tecnologia de fila para o processamento em segundo plano

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** É a principal decisão de stack da fase — o `project-plan.md` a deixa explicitamente como TBD, e o diagrama de arquitetura reserva um container "Message Queue" sem nomeá-lo. A escolha condiciona TD-04 (como o worker consome), TD-08 (retry, dead letter, idempotência) e o `compose.yaml`. O volume real é modesto: um job por upload concluído, num projeto de MBA rodando localmente — o dimensionamento honesto é dezenas de jobs por dia, não milhares por segundo. O usuário já opera Redis; não conhece RabbitMQ nem Kafka, mas aceita adotá-los se forem tecnicamente superiores.

**Options:**

### Option A: BullMQ sobre Redis (`bullmq` 5.81.2 + `@nestjs/bullmq` 11.0.4)
- Fila de jobs em Redis, com wrapper oficial do NestJS. Decoradores `@Processor`/`@WorkerHost` integram o worker ao ciclo de vida do Nest. Traz retry com backoff exponencial, `attempts`, jobs atrasados, prioridade, concorrência e a fila `failed` como dead letter nativa.
- **Pros:** `@nestjs/bullmq` v11 casa exatamente com NestJS 11 — a integração é de primeira classe, não adaptação. Redis é um único container leve no Compose. Retry/DLQ/idempotência vêm prontos, cobrindo TD-08 sem código próprio. Familiaridade do usuário reduz risco real de depuração num escopo que já é grande. `BullMQ` é o padrão de fato para jobs em Node.
- **Cons:** Redis é primariamente in-memory — durabilidade depende de configurar AOF/RDB; um crash sem persistência configurada perde jobs enfileirados. Não é um broker AMQP: sem roteamento por exchange/topic, sem fan-out sofisticado. Acopla o projeto ao Redis para além de cache.

### Option B: RabbitMQ (broker AMQP, via `@nestjs/microservices` ou `@golevelup/nestjs-rabbitmq`)
- Broker de mensagens maduro com exchanges, filas duráveis, ack manual, dead-letter exchange nativa e políticas de retry por TTL. NestJS oferece transporte RabbitMQ nativo em `@nestjs/microservices`.
- **Pros:** Durabilidade e garantias de entrega são o propósito do produto, não uma configuração. Dead-letter exchange é um conceito de primeira classe. Roteamento rico, útil se a Fase 06+ trouxer múltiplos tipos de evento. Ack manual dá controle fino sobre reprocessamento.
- **Cons:** Um serviço a mais para operar (Erlang, mais pesado que Redis). O modelo mental (exchange → binding → queue) é novo para o usuário — custo de aprendizado real, dentro de uma fase já grande. O transporte do `@nestjs/microservices` é orientado a RPC/eventos, não a *job queue*: retry com backoff, agendamento e concorrência por worker precisam ser construídos à mão ou via lib de terceiros.

### Option C: Apache Kafka (`@nestjs/microservices` transporte Kafka, ou KafkaJS)
- Log distribuído de eventos particionado, com retenção configurável e consumidores por offset.
- **Pros:** Throughput em outra ordem de grandeza (>1M msg/s por broker). Reprocessamento histórico por rebobinar offset. Padrão para pipelines de dados e múltiplos consumidores analíticos.
- **Cons:** Resolve um problema que esta fase não tem. Operacionalmente o mais caro dos três (broker + coordenação; mesmo com KRaft, é o container mais pesado do Compose). Não é uma fila de tarefas: retry por job, backoff e dead letter precisam ser implementados por cima. Custo de aprendizado alto para benefício nulo no volume real da fase.

**Recommendation:** **Option A — BullMQ sobre Redis.** A carga da fase é de dezenas de jobs por dia, então throughput não é critério de desempate — o que decide é qual opção entrega retry, backoff e dead letter com menos código próprio, e qual integra melhor com NestJS 11. BullMQ ganha nos dois: `@nestjs/bullmq` 11 é a integração oficial da mesma major do framework, e TD-08 vira configuração em vez de implementação. Kafka é descartável de saída — é event streaming resolvendo um problema que não existe aqui. RabbitMQ seria a escolha certa se a fase precisasse de roteamento por exchange ou garantias transacionais de entrega, e não precisa: é um único tipo de job, um único consumidor. Restaria o argumento de durabilidade, e ele se resolve habilitando persistência AOF no Redis — mais barato que adotar um broker novo. A familiaridade do usuário não é o motivo da escolha, mas reforça-a: reduz risco de operação num escopo que já é o maior da fase.

**Decision:** A (BullMQ sobre Redis)

---

## TD-02: Organização de buckets e chaves no object storage

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O storage está dado (S3-compatível / MinIO), mas a organização de buckets e o formato das chaves é decisão aberta e cara de mudar depois — chave é identidade de objeto, e renomear em massa significa copiar terabytes. A escolha também define a fronteira de exposição pública: thumbnail precisa ser servida a anônimos, vídeo bruto não.

**Options:**

### Option A: Bucket único, prefixo por tipo de artefato
- Um bucket (`streamtube`), com chaves `videos/{videoId}/source.mp4` e `thumbnails/{videoId}/default.jpg`.
- **Pros:** Um único bucket para criar, configurar e versionar. Chave carrega o `videoId`, então a origem de qualquer objeto é óbvia ao inspecionar o storage. Simples de espelhar em produção.
- **Cons:** Política de acesso é por prefixo, não por bucket — mais sutil de configurar corretamente. Lifecycle rules distintas (ex.: expirar multipart incompleto só dos vídeos) exigem filtro por prefixo.

### Option B: Buckets separados por finalidade
- `streamtube-videos` (privado) e `streamtube-thumbnails` (leitura pública).
- **Pros:** Fronteira de acesso explícita no nível do bucket — o thumbnail público não pode vazar o vídeo por engano de prefixo. Lifecycle e políticas independentes por bucket.
- **Cons:** Dois buckets para provisionar no bootstrap do MinIO e manter em sincronia. A relação entre um vídeo e seu thumbnail deixa de ser observável só pela chave.

### Option C: Bucket único com chave opaca (hash), sem estrutura semântica
- Chave derivada de hash do conteúdo ou UUID plano, sem hierarquia.
- **Pros:** Distribuição uniforme de chaves; deduplicação natural se a chave for hash do conteúdo.
- **Cons:** Impossível inspecionar o storage e entender a que vídeo um objeto pertence sem consultar o banco. Depurar incidente fica dependente do Postgres estar consistente — exatamente o cenário em que ele pode não estar.

**Recommendation:** **Option B — buckets separados por finalidade.** O critério decisivo é a fronteira de acesso, não a conveniência: thumbnail é servida a usuários anônimos e vídeo bruto nunca deve ser, e essa distinção fica muito mais difícil de errar quando é uma propriedade do bucket em vez de um prefixo dentro de um bucket compartilhado. Dentro de cada bucket, manter a chave com o `videoId` (`{videoId}/source.mp4`, `{videoId}/default.jpg`) preserva a inspecionabilidade que a Option C perde. O custo é provisionar dois buckets no bootstrap — trivial, e feito uma vez.

**Decision:** B (Buckets separados por finalidade)

---

## TD-03: Protocolo de upload de arquivos de até 10GB

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"; "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** É a decisão mais restrita da fase: o enunciado do desafio classifica como **reprova automática** "passar o arquivo de 10GB pela API de forma que trave o sistema". O arquivo precisa ir do cliente ao storage sem transitar pelo processo Node. Há um limite técnico que elimina a opção mais simples: **uma URL pré-assinada de `PUT` simples aceita no máximo 5GB** — tanto na AWS S3 quanto no MinIO, que replica a limitação. Como o requisito é 10GB, o multipart não é refinamento opcional, é obrigatório. A capability de pré-cadastro está acoplada aqui porque o rascunho nasce no *início* do handshake, não no fim.

**Options:**

### Option A: Multipart upload com URLs pré-assinadas por parte
- Três passos: (1) `POST /videos` cria o rascunho no banco e inicia o multipart no storage, devolvendo `videoId`, `uploadId` e URLs pré-assinadas por parte; (2) o cliente envia cada parte direto ao storage e coleta os `ETag`; (3) `POST /videos/{id}/complete` recebe a lista de `{PartNumber, ETag}`, finaliza o multipart e enfileira o processamento.
- **Pros:** Único caminho que suporta 10GB. O byte nunca toca a API. Partes falhas são reenviadas isoladamente, sem reiniciar o upload. Paralelismo de partes. O passo (1) é exatamente o momento natural do pré-cadastro como rascunho. Limites do S3: até 10.000 partes, cada uma entre 5MB e 5GB.
- **Cons:** Handshake de três passos, mais complexo de implementar e de documentar no OpenAPI que um PUT único. Exige limpar multipart abandonado (lifecycle rule), sob pena de acumular partes órfãs que consomem storage invisível.

### Option B: URL pré-assinada `PUT` única
- `POST /videos` cria o rascunho e devolve uma URL pré-assinada; o cliente faz um `PUT` do arquivo inteiro.
- **Pros:** O handshake mais simples possível — dois passos. Nada para limpar.
- **Cons:** **Teto de 5GB**, metade do requisito da fase. Falha de rede no fim de um envio de horas obriga a recomeçar do zero. Descartada por não atender ao requisito.

### Option C: Protocolo tus (upload resumível) com servidor tus dedicado
- Protocolo aberto de upload resumível, com um servidor tus como container próprio, encaminhando ao storage ao final.
- **Pros:** Retomada é a razão de ser do protocolo, com semântica bem definida. Bom suporte de cliente (Uppy).
- **Cons:** Introduz um serviço a mais na fase que já traz storage, fila e worker. O arquivo passa a transitar por um processo intermediário — resolve o requisito "não travar a API", mas reintroduz um hop que o multipart pré-assinado elimina. Fora do que a arquitetura do projeto prevê.

**Recommendation:** **Option A — multipart com URLs pré-assinadas por parte.** A Option B está tecnicamente eliminada: 5GB não atende a um requisito de 10GB, e isso é limite do protocolo, não de configuração. Entre A e C, A não acrescenta serviço algum ao Compose e mantém o byte indo direto do cliente ao storage, que é exatamente o que o critério de reprova exige. Duas consequências de implementação precisam ser tratadas no plano, não descobertas depois: **(1)** as URLs pré-assinadas são consumidas pelo *cliente*, então precisam apontar para um endereço que o cliente alcança — o nome de serviço do Compose (`minio:9000`) resolve dentro da rede Docker mas não do navegador, o que exige configurar o endpoint público do MinIO separadamente do endpoint interno; **(2)** um lifecycle rule para expirar multipart incompleto é obrigatório, senão uploads abandonados acumulam partes órfãs silenciosamente.

**Decision:** A (Multipart com URLs pré-assinadas por parte)

---

## TD-04: Onde e como o worker de processamento roda

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** O processamento é CPU-intensivo e pode levar minutos num arquivo grande. Onde ele executa determina se um vídeo pesado degrada o tempo de resposta da API, e o `software-arch.mermaid` já prevê o "Video Worker" como container próprio. Há também uma restrição concreta: o worker precisa do binário do FFmpeg, que a imagem da API não tem e não deveria ganhar.

**Options:**

### Option A: Container separado, mesma base de código
- Um serviço `video-worker` no Compose, subindo o mesmo projeto NestJS por um entrypoint distinto (`worker.main.ts`) que carrega apenas o módulo de processamento. Imagem própria, com FFmpeg instalado.
- **Pros:** Isolamento real de CPU — processar vídeo não compete com o event loop que atende requisições. Escala independente (subir N workers sem tocar a API). FFmpeg fica só na imagem que precisa dele, mantendo a imagem da API enxuta. Compartilha entidades, config e migrations com a API, sem duplicação. É o que o diagrama de arquitetura já previa.
- **Cons:** Um serviço a mais no Compose e nos quality gates. Dois entrypoints para manter. Um Dockerfile adicional.

### Option B: Worker no mesmo processo da API
- O `@Processor` do BullMQ roda dentro do próprio processo da API.
- **Pros:** Zero infraestrutura nova. Um único processo para operar e depurar.
- **Cons:** Processamento de vídeo compete com o atendimento HTTP no mesmo event loop — mesmo com o FFmpeg em subprocesso, o pico de CPU e I/O degrada a latência da API. Impossível escalar processamento sem escalar a API. Obriga a instalar FFmpeg na imagem da API. **Contraria o diagrama de arquitetura do projeto**, que reserva um container próprio.

### Option C: Container separado, projeto Node independente
- Um subprojeto novo, com `package.json` próprio, consumindo a fila.
- **Pros:** Isolamento máximo de dependências; o worker poderia até não ser NestJS.
- **Cons:** Duplica entidades TypeORM, config e conexão de banco — que precisariam ficar sincronizadas à mão com o backend. Custo alto de manutenção para benefício marginal num monorepo cujo backend já é NestJS.

**Recommendation:** **Option A — container separado compartilhando a base de código.** A Option B é a que mais economiza esforço agora e a que mais cobra depois: o ponto inteiro de processar em segundo plano é não deixar um vídeo de 10GB afetar quem está navegando, e rodar no mesmo processo desfaz isso. A Option C paga um preço de duplicação que só compensaria se o worker tivesse stack diferente, e não tem. A Option A entrega o isolamento sem duplicar domínio, e é a única compatível com o `software-arch.mermaid`. Duas consequências para o plano: o novo serviço precisa entrar em `scripts/run-gate.mjs` com seus gate ids (via skill `gate-builder`), e o Dockerfile do worker precisa instalar FFmpeg e ffprobe.

**Decision:** A (Container separado, mesma base de código)

---

## TD-05: Ferramenta de extração de metadados e geração de thumbnail

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)"; "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O worker precisa ler duração/resolução/codec e extrair um frame como thumbnail. A escolha aparentemente óbvia está indisponível: **`fluent-ffmpeg`, o wrapper mais citado do ecossistema, foi arquivado em maio de 2025** e o próprio repositório declara que "não é mais mantido e não funciona corretamente com versões recentes do ffmpeg" (`npm` marca o pacote como deprecated). Adotá-lo hoje é dívida técnica no dia um — este é exatamente o tipo de armadilha que a etapa de research existe para pegar, já que a maioria dos tutoriais ainda o recomenda.

**Options:**

### Option A: `child_process` chamando `ffmpeg`/`ffprobe` diretamente
- O worker invoca os binários instalados na imagem via `execFile`, lendo o JSON de `ffprobe -show_format -show_streams -print_format json` e gerando o thumbnail com `ffmpeg -ss <t> -i <in> -frames:v 1 <out>`.
- **Pros:** Sem dependência de wrapper — nada a ficar obsoleto. Acesso à superfície completa do FFmpeg, incluindo flags recentes. `ffprobe` já devolve JSON, então não há parsing frágil de texto. `execFile` (em vez de `exec`) passa argumentos como array, sem shell, o que elimina injeção por nome de arquivo. Depurável: o comando executado é reproduzível no terminal.
- **Cons:** É preciso escrever a fina camada de invocação, timeout e tratamento de erro. Sem tipagem para as opções do FFmpeg — os argumentos são strings, validadas apenas em runtime.

### Option B: `fluent-ffmpeg` (2.1.3)
- API fluente sobre os binários.
- **Pros:** API expressiva e enorme volume de exemplos acumulados.
- **Cons:** **Arquivado e deprecated desde maio de 2025**, com incompatibilidade declarada com versões recentes do FFmpeg. Adotar uma dependência morta numa fase nova é dívida imediata. Descartada.

### Option C: `ffmpeg.wasm` (`@ffmpeg/ffmpeg`)
- Build WebAssembly do FFmpeg, sem binário nativo.
- **Pros:** Dispensa instalar FFmpeg na imagem; mesmo código roda no browser.
- **Cons:** Substancialmente mais lento que o binário nativo — inaceitável para arquivos de até 10GB. Limitações de memória do WASM. Resolve um problema (ausência de binário) que num container próprio não existe.

**Recommendation:** **Option A — invocação direta via `child_process`.** A Option B seria a escolha natural e é justamente a que precisa ser evitada: está arquivada. A Option C troca desempenho por uma conveniência que o container já resolve. Chamar `ffprobe`/`ffmpeg` diretamente custa uma camada fina de código, sem dependência que possa apodrecer, e o `ffprobe` devolvendo JSON nativamente elimina a parte historicamente frágil (parsing de saída textual). Usar `execFile` com array de argumentos, nunca `exec` com string interpolada — nome de arquivo vindo do usuário em linha de comando é vetor de injeção.

**Decision:** A (child_process chamando ffmpeg/ffprobe direto)

---

## TD-06: Identificador público único por vídeo

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Cada vídeo precisa de uma URL única e sem conflito. O identificador aparece na URL pública, então além de único ele é a superfície por onde alguém pode tentar enumerar o acervo. O projeto já usa `uuid_generate_v4()` como default de PK nas entidades existentes — a questão é se o identificador público deve ser a própria PK ou um campo separado.

**Options:**

### Option A: UUID v4 da PK exposto diretamente
- A URL usa o `id` da entidade: `/videos/3f2a…`.
- **Pros:** Zero campo extra e zero código — a unicidade vem do banco. Consistente com as entidades já existentes. Não enumerável.
- **Cons:** 36 caracteres numa URL que será compartilhada por usuários. Expõe a chave primária na superfície pública, acoplando identidade interna e externa. UUID v4 é aleatório, então como PK indexada tem localidade de escrita ruim em índices B-tree.

### Option B: Slug curto aleatório em coluna própria (estilo YouTube)
- Coluna `public_id` com identificador curto (11 caracteres, alfabeto base62), único e indexado; a PK segue UUID interno.
- **Pros:** URL curta e compartilhável, próxima do que a plataforma que serve de referência faz. Separa identidade interna de identidade pública — a PK pode mudar de estratégia sem quebrar URL publicada. 62^11 é espaço amplo o bastante para tornar enumeração inviável.
- **Cons:** Uma coluna e um índice único a mais. Precisa de tratamento de colisão na geração (improvável, mas não impossível) — o projeto já tem esse padrão resolvido em `channels.service.ts`, com retry por SAVEPOINT.

### Option C: Slug derivado do título + sufixo
- `meu-video-abc123`, a partir do título.
- **Pros:** Legível e melhor para SEO.
- **Cons:** Título é editável na Fase 04 — ou a URL muda (quebrando links) ou diverge do título (confundindo). Exige normalizar acentuação, e o título não é único.

**Recommendation:** **Option B — slug curto aleatório em coluna própria.** O ganho decisivo não é a URL mais bonita, é o desacoplamento: URL publicada é um compromisso permanente com o usuário, e amarrá-la à chave primária significa que qualquer mudança futura de estratégia de PK quebra links que já circulam. A Option C amarra a URL a um campo que a Fase 04 torna editável, o que é pior. O custo da B é uma coluna com índice único e tratamento de colisão — e o projeto já tem esse padrão pronto e testado na geração de nickname de canal, que pode ser reaproveitado em vez de reinventado.

**Decision:** B (Slug curto aleatório em coluna própria)

---

## TD-07: Estratégia de entrega — streaming e download

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)"; "Download do vídeo pelo usuário"

**Context:** O player precisa buscar posição no vídeo sem baixar o arquivo inteiro, o que na prática significa honrar o header `Range` e responder `206 Partial Content` com `Content-Range`. A questão é se esses bytes passam pela API ou vão direto do storage ao cliente — e a resposta precisa ser coerente com TD-03, que tirou o upload do caminho da API justamente para não travá-la. Vídeo é conteúdo público para anônimos (o `project-plan.md` prevê acesso anônimo), mas o objeto no bucket é privado por TD-02.

**Options:**

### Option A: Redirecionar para URL pré-assinada de `GET`
- `GET /videos/{publicId}/stream` valida o vídeo e responde `302` para uma URL pré-assinada de curta duração; o cliente busca os bytes direto do storage, e é o storage que trata `Range`/`206`.
- **Pros:** Simétrico ao upload de TD-03 — o byte não passa pela API, nem na entrada nem na saída. `Range` e `206` são responsabilidade do S3/MinIO, que já os implementam corretamente; nada a escrever. Escala sem consumir o event loop. Download é a mesma mecânica com `response-content-disposition: attachment`.
- **Cons:** A URL pré-assinada é copiável enquanto válida — o controle de acesso vira janela de tempo, não verificação por requisição. Contagem de views precisa ser feita no endpoint que redireciona, não no consumo real dos bytes. Vale a mesma pegadinha de endpoint público do TD-03.

### Option B: Proxy de streaming pela API
- A API lê o `Range`, busca a faixa no storage via `GetObject` com `Range` e devolve `206` com o `StreamableFile` do NestJS.
- **Pros:** Controle de acesso por requisição — dá para revogar imediatamente. Views contadas no consumo real. O objeto nunca fica exposto por URL alguma.
- **Cons:** Todo byte de vídeo atravessa o processo Node, exatamente o que TD-03 evitou no upload. Uma dezena de espectadores simultâneos ocupa o event loop com I/O de streaming. Exige implementar parsing de `Range` e montagem de `Content-Range` à mão — código sutil, com casos de borda (range aberto, unidade inválida, `416`).

### Option C: URL pública permanente no bucket
- Bucket de vídeos com leitura pública; a URL do objeto é a URL de streaming.
- **Pros:** O mais simples possível; nada no caminho.
- **Cons:** Elimina qualquer controle de acesso — inviabiliza a visibilidade *unlisted* que a Fase 04 exige, e vídeos em processamento ou rascunho ficariam acessíveis. Contraria a fronteira de acesso definida em TD-02.

**Recommendation:** **Option A — redirect para URL pré-assinada.** É a opção coerente com a decisão que a fase já tomou no upload: se o argumento para não passar 10GB pela API na entrada é válido, ele vale igualmente na saída, onde o volume acumulado é maior (um upload, muitas reproduções). Além disso, `Range`/`206` correto é código sutil, e o S3/MinIO já o implementa — reescrevê-lo na API é assumir risco sem contrapartida. A Option C é eliminada por inviabilizar o *unlisted* da Fase 04. O ponto fraco reconhecido da A é o controle de acesso virar janela temporal: mitiga-se com expiração curta (minutos) e mantendo a validação de status/visibilidade no endpoint que emite o redirect — o que também dá o gancho natural para contagem de views na Fase 05.

**Decision:** A (Redirect para URL pré-assinada de GET)

---

## TD-08: Ciclo de status, retry, dead letter e idempotência

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"; "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** O vídeo atravessa estados observáveis (rascunho → processando → pronto/erro) que precisam estar refletidos no banco, e o processamento pode falhar por motivos transitórios (storage indisponível) ou permanentes (arquivo corrompido) — tratá-los igual é errado, porque um se resolve tentando de novo e o outro só acumula tentativas inúteis. Como a fila entrega *pelo menos uma vez*, o mesmo job pode rodar duas vezes; o handler precisa ser idempotente sob pena de thumbnails duplicados ou estado inconsistente.

**Options:**

### Option A: Status como enum na tabela + retry do BullMQ + fila `failed` como DLQ
- Coluna `status` (`draft | uploading | processing | ready | failed`) como enum Postgres. O worker escreve a transição; o BullMQ cuida de `attempts` com backoff exponencial; jobs esgotados caem na fila `failed`, que serve de dead letter. Idempotência por verificação de estado no início do handler (se já está `ready`, encerra sem reprocessar).
- **Pros:** Estado consultável direto no banco, sem depender da fila para responder "esse vídeo está pronto?" — a API não precisa consultar o Redis para servir um `GET /videos/{id}`. Retry/backoff/DLQ são configuração no BullMQ, não código. O enum é validado pelo banco, e o projeto já tem precedente (`verification_tokens_type_enum`). A guarda de idempotência é uma condição no começo do handler.
- **Cons:** Estado vive em dois lugares (banco e fila) e pode divergir se o worker morrer entre processar e persistir. Enum no Postgres tem custo de migration para adicionar valores — e a Fase 04 vai precisar de estados de publicação.

### Option B: Máquina de estados explícita, com tabela de transições
- Transições validadas por uma máquina de estados, com histórico auditável em tabela própria.
- **Pros:** Transição inválida é impedida estruturalmente. Histórico completo, útil para depurar falhas de processamento.
- **Cons:** Overhead considerável para cinco estados e um caminho feliz linear. Tabela e código a manter sem demanda de auditoria no enunciado.

### Option C: Status derivado do estado do job na fila
- Sem coluna: o status é consultado no BullMQ pelo id do job.
- **Pros:** Fonte única de verdade; nada para sincronizar.
- **Cons:** Toda leitura de vídeo passa a depender do Redis, inclusive listagens. BullMQ expira jobs concluídos por padrão, então o histórico some. Filtrar por status no banco (necessário na Fase 04) torna-se inviável.

**Recommendation:** **Option A — enum no banco somado ao retry nativo do BullMQ.** A Option C é eliminada por acoplar leitura de vídeo à disponibilidade do Redis e por perder o estado quando o job expira — a Fase 04 precisa listar vídeos por status, e isso tem que ser uma consulta SQL. A Option B resolve um problema de auditoria que o enunciado não pede, ao custo de infraestrutura de máquina de estados para cinco estados lineares. A Option A entrega o essencial com o que a stack já oferece. Três pontos que o plano precisa fixar explicitamente, porque são onde esse desenho costuma falhar: **(1)** distinguir falha transitória (repetir) de permanente (marcar `failed` sem gastar tentativas); **(2)** a guarda de idempotência no início do handler, já que a entrega é *at-least-once*; **(3)** o job precisa ser enfileirado **depois** do commit da transação que muda o status, senão o worker pode buscar uma linha que ainda não existe — condição de corrida clássica e difícil de reproduzir.

**Decision:** A (Enum no banco + retry nativo do BullMQ)

---

## TD-09: Política de inputs aceitos e onde ela é validada

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"; "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** A TD-03 tirou o byte do caminho da API — o cliente escreve direto no storage por URLs pré-assinadas. Isso elimina o ponto onde normalmente se valida upload (o interceptor que inspeciona o arquivo), e deixa três exigências sem dono. **(1)** O limite de 10GB do enunciado precisa ser recusado *antes* do upload, não descoberto depois. **(2)** A TD-08 exige distinguir falha transitória de permanente, e "o arquivo não é um vídeo" é justamente o caso permanente que não deve gastar tentativas — mas nenhuma regra diz o que torna um input inválido. **(3)** A TD-07 entrega o **objeto original** por URL pré-assinada e a fase não transcodifica nada, então o que se aceita na entrada determina se o entregável "streaming funcionando" vale para todo vídeo aceito ou só para alguns. Levantado como `MD-1` pelo `/plan-validate 03`.

**Options:**

### Option A: Declaração validada na iniciação + verificação real no worker
- O `POST` de iniciação recebe nome, tamanho e mime declarados; a API confere contra um allowlist e contra o teto de 10GB, e só emite as URLs pré-assinadas se passar. A verdade é estabelecida depois pelo worker: o `ffprobe` da TD-05 lê contêiner e streams reais; divergência ou contêiner fora do allowlist marca `failed` permanente, sem retry.
- **Pros:** Nada transita pela API — o critério de reprova da fase continua respeitado. O teto de 10GB é recusado no primeiro request, antes de qualquer byte subir. A verificação real não custa dependência nova: o `ffprobe` já roda para extrair metadados, então é uma condição a mais no handler que já existe. Dá à TD-08 a regra concreta que ela pediu para classificar falha permanente. O custo de um upload ruim é limitado pela lifecycle rule da TD-03 mais o delete no caminho de falha.
- **Cons:** Declaração é autodeclarada — um cliente que minta no mime sobe o arquivo inteiro antes de ser rejeitado pelo worker (desperdício de banda e de storage temporário, não de correção). A política passa a ser afirmada em dois lugares (API e worker), o que exige uma constante compartilhada para não divergir.

### Option B: Validação apenas no worker
- A API emite URLs pré-assinadas para qualquer coisa; o worker é o único portão, rejeitando depois do upload concluído.
- **Pros:** Uma única fonte de verdade, sem risco de divergência entre dois pontos. Contrato de iniciação mínimo.
- **Cons:** Nenhum feedback antecipado — o usuário descobre que mandou um `.txt` depois de esperar o upload terminar. Pior: o teto de 10GB deixa de ser aplicável de fato, porque o tamanho só é conhecido no fim, o que colide frontalmente com a capability "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance". Transforma abuso trivial em custo de storage.

### Option C: Restrições assinadas na própria URL pré-assinada
- Usar as *conditions* da policy do S3 (`content-length-range`, `Content-Type`) para o próprio storage recusar o que estiver fora da política, sem confiar no cliente nem na API.
- **Pros:** Aplicação pelo storage, não por confiança no cliente — o mais forte dos três em teoria.
- **Cons:** **Incompatível com a TD-03.** As *conditions* de policy pertencem ao presigned **POST** (upload de request único); o que a TD-03 decidiu é presigned **PUT por parte** de multipart, onde não existe esse mecanismo — assina-se headers específicos, e um limite por parte não impõe limite ao total. Escolher C exigiria reabrir a TD-03 e abandonar o multipart, que é obrigatório pelo teto de 5GB do PUT simples. Eliminada por incompatibilidade, não por preferência.

**Recommendation:** **Option A — declaração validada na iniciação, verdade estabelecida pelo worker.** A Option C está tecnicamente fora (não existe sob multipart pré-assinado) e a Option B abandona a única defesa possível do teto de 10GB. Restam os parâmetros, que precisam ser fixados aqui e não descobertos na implementação:

- **Allowlist: `video/mp4` e `video/webm`.** É a escolha que mantém o entregável honesto. Como a TD-07 serve o original e esta fase não transcodifica, aceitar `.mkv` ou `.mov` significaria aceitar arquivos que o navegador não toca — "streaming funcionando" passaria a valer só para parte dos uploads. MP4 e WebM são os dois contêineres que os navegadores reproduzem nativamente, então tudo que é aceito é reproduzível. Ampliar o allowlist é assunto da fase que introduzir transcodificação: não há capability de transcodificação na Fase 03, e criar uma seria requisito inventado.
- **Verificação do worker:** `format_name` do `ffprobe` compatível com o allowlist **e** existência de ao menos um stream de vídeo. Falhar qualquer uma das duas → `failed` permanente, sem consumir `attempts`.
- **Sem limite de duração.** Nenhuma capability da fase pede um, e o enunciado fixa o limite em tamanho (10GB), não em tempo. Um teto de duração seria requisito sem origem identificável.
- **Uma constante, dois consumidores.** O allowlist mora num único módulo de `src/videos/` importado pela API e pelo worker — a TD-04 mantém os dois na mesma base de código, então a divergência que é o `Con` da Option A se resolve por construção, não por disciplina.

**Decision:** _[pending]_

---

## TD-10: Cliente S3 para Node — presign de parte, presign de GET e lifecycle rule

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)"; "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"; "Reprodução via streaming (sem necessidade de download completo)"; "Download do vídeo pelo usuário"

**Context:** Três decisões já tomadas dependem de um cliente S3 no runtime Node e nenhuma diz qual: a TD-02 provisiona dois buckets no bootstrap, a TD-03 assina uma URL por parte de multipart e exige a lifecycle rule que expira multipart incompleto, e a TD-07 assina `GET`. As **Notas para o `/plan-resolve`** deste documento classificaram a escolha como detalhe de implementação — essa classificação está sendo revista aqui por dois motivos concretos. Primeiro, o teste do próprio `/research`: a escolha é citada em configuração, serviço de storage, worker e `compose.yaml`, que precisam permanecer consistentes — é contrato cross-component, não detalhe local. Segundo, o pipeline: o `/plan-resolve` em phase mode **não pode criar TDs**, e o `library-refs.md` é montado a partir do campo `Libraries` das TDs — sem uma TD, a biblioteca fica sem origem rastreável e a consulta obrigatória via context7 sem alvo. Levantado como `MD-2` pelo `/plan-validate 03`.

**Options:**

### Option A: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`
- SDK oficial da AWS, modular. `getSignedUrl(client, command, { expiresIn })` assina qualquer command — inclusive `UploadPartCommand` e `GetObjectCommand`. `PutBucketLifecycleConfigurationCommand` aceita `AbortIncompleteMultipartUpload: { DaysAfterInitiation }`. Compatibilidade com storage S3-compatível pela combinação documentada `endpoint` + `forcePathStyle: true`.
- **Pros:** As quatro operações da fase são commands documentados de primeira classe — verificado via context7 nesta pesquisa, incluindo o XML/shape da lifecycle rule com `AbortIncompleteMultipartUpload`. A armadilha do endpoint duplo da TD-03 (interno para o servidor, público para o navegador que consome a URL assinada) resolve-se com duas instâncias de client ou override por chamada, sem gambiarra de string. Mantém o código portável para S3 real em produção, que é a intenção declarada pelo `software-arch.mermaid` ("S3/MinIO"). Tipos TypeScript no pacote; instalação modular, sem arrastar o SDK inteiro.
- **Cons:** API verbosa (um objeto de command por operação). O comportamento default de checksum do SDK v3 (`requestChecksumCalculation: "WHEN_SUPPORTED"`, que adiciona CRC32) é ponto de fricção conhecido com servidores S3-compatíveis e com requests pré-assinados, onde o cliente precisa enviar exatamente os headers assinados — precisa ser verificado contra o MinIO na implementação. Dois pacotes em vez de um.

### Option B: `minio` (cliente oficial do MinIO para JS)
- Cliente de alto nível específico para MinIO e servidores S3-compatíveis. `presignedGetObject` cobre a TD-07 direto; `presignedUrl(method, bucket, object, expires, reqParams)` é genérico e permite assinar `PUT ?uploadId&partNumber`.
- **Pros:** API mais enxuta e menos cerimoniosa que a do AWS SDK para os casos simples — `presignedGetObject` é uma chamada. Pacote único. Feito exatamente para o servidor que roda no Compose.
- **Cons:** Orquestrar multipart pré-assinado depende de superfície **não pública**: a consulta via context7 mostra `initiateNewMultipartUpload` em `src/internal/client.ts`, ou seja, para obter o `uploadId` seria preciso chamar API interna ou emitir o `POST ?uploads` à mão. Depender de interno é a mesma classe de dívida que a TD-05 recusou ao rejeitar o `fluent-ffmpeg` — só que aqui no dia um. A limpeza de multipart abandonado que a documentação expõe é `removeIncompleteUpload`, por objeto, não a regra de bucket que a TD-03 exige (o suporte a `setBucketLifecycle` não apareceu na consulta e precisaria ser confirmado antes de escolher esta opção). Amarra o código ao MinIO, contrariando a intenção de portabilidade.

### Option C: HTTP direto com assinatura SigV4 própria
- Implementar a assinatura SigV4 e falar com o endpoint S3 por `fetch`, sem SDK.
- **Pros:** Zero dependência de storage no `package.json`. Controle total sobre exatamente quais headers são assinados, o que elimina de saída a fricção de checksum da Option A.
- **Cons:** SigV4 é criptografia de protocolo, e é exatamente a categoria de código sutil que a TD-07 se recusou a reescrever quando delegou `Range`/`206` ao storage. Erro de assinatura se manifesta como `403` opaco, difícil de depurar. Nenhum ganho funcional sobre a Option A.

**Recommendation:** **Option A — `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`.** As quatro operações que a fase precisa foram confirmadas como API pública documentada nesta pesquisa, enquanto a Option B exige API interna justamente na operação central da TD-03 — e o projeto já estabeleceu, na TD-05, que depender de superfície instável ou não mantida é dívida a evitar na origem, não a aceitar por conveniência de sintaxe. A Option C troca uma dependência por código criptográfico próprio, sem nada em troca. Duas consequências para o plano, ambas herdadas de decisões anteriores e agora com solução concreta:

- **Dois endpoints, um cliente.** `endpoint: http://minio:9000` (nome de serviço do Compose, como o `CLAUDE.md` exige) para o que o servidor faz por conta própria — criar buckets, aplicar lifecycle, iniciar e completar multipart; e um endpoint público, vindo de env própria, para **assinar** as URLs que o navegador vai consumir. É a armadilha nº 1 da TD-03 resolvida por configuração explícita, e não é licença para `localhost` em host de serviço: é um segundo valor, declarado, com finalidade única.
- **`forcePathStyle: true`** é obrigatório contra MinIO — sem ele o SDK monta URL virtual-hosted (`bucket.minio:9000`), que não resolve na rede do Compose.
- Versão a fixar em `library-refs.md` pelo `/plan-resolve`. O context7 confirmou o **formato da API** (`getSignedUrl`, `UploadPartCommand`, `PutBucketLifecycleConfigurationCommand`, `endpoint` + `forcePathStyle`); a versão exata continua sendo item de confirmação daquele estágio.

**Decision:** _[pending]_

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Tecnologia de fila | A — BullMQ sobre Redis (`@nestjs/bullmq` 11) | A |
| TD-02 | Backend | Organização de buckets e chaves | B — buckets separados por finalidade | B |
| TD-03 | Backend | Protocolo de upload de até 10GB | A — multipart com URLs pré-assinadas por parte | A |
| TD-04 | Backend | Execução do worker | A — container separado, mesma base de código | A |
| TD-05 | Backend | Extração de metadados e thumbnail | A — `child_process` direto (`fluent-ffmpeg` está arquivado) | A |
| TD-06 | Backend | Identificador público do vídeo | B — slug curto aleatório em coluna própria | B |
| TD-07 | Backend | Streaming e download | A — redirect para URL pré-assinada de `GET` | A |
| TD-08 | Backend | Ciclo de status, retry e idempotência | A — enum no banco + retry nativo do BullMQ | A |
| TD-09 | Backend | Política de inputs aceitos e ponto de validação | A — declaração validada na iniciação + verdade no worker | _[pending]_ |
| TD-10 | Backend | Cliente S3 para Node | A — `@aws-sdk/client-s3` + `s3-request-presigner` | _[pending]_ |

## Notas para o `/plan-resolve`

Bibliotecas a confirmar via **context7** e fixar em `library-refs.md` (versões verificadas no registry npm em 2026-07-25, ainda **não** confirmadas via context7 por indisponibilidade do MCP nesta sessão):

| Pacote | Versão | Depende de |
|---|---|---|
| `bullmq` | 5.81.2 | TD-01 |
| `@nestjs/bullmq` | 11.0.4 | TD-01 |
| `@aws-sdk/client-s3` | 3.1095.0 | TD-10 (usado por TD-02, TD-03, TD-07) |
| `@aws-sdk/s3-request-presigner` | 3.1095.0 | TD-10 (usado por TD-03, TD-07) |

**Revisão desta nota (2026-07-26).** A versão anterior deste parágrafo afirmava que a escolha entre o AWS SDK e o cliente `minio` era "detalhe de implementação dentro das TDs acima, não uma TD própria". Essa classificação foi revertida: o `/plan-validate 03` levantou a lacuna como `MD-2`, e a escolha virou a **TD-10**. Dois motivos, ambos verificáveis. (1) O teste do `/research` — a escolha é citada em config, serviço de storage, worker e `compose.yaml`, que precisam permanecer consistentes; é contrato cross-component. (2) O `/plan-resolve` em phase mode não cria TDs, e o `library-refs.md` é montado a partir do campo `Libraries` das TDs — sem TD, a biblioteca não tem origem rastreável e a consulta obrigatória via context7 fica sem alvo. A comparação foi feita via context7 e está registrada nas Options da TD-10.

Sem dependência nova para TD-05 nem para TD-09: FFmpeg e ffprobe entram como binários no Dockerfile do worker, não como pacote npm. A TD-09 reaproveita o `ffprobe` da TD-05 como ponto de verificação — nenhum pacote adicional.

**Pendências deste documento para o `/plan-resolve` preencher:** TD-09 e TD-10 estão em `_[pending]_` (por isso o `status:` do frontmatter voltou a `pending`). As oito primeiras seguem decididas e **não devem ser reabertas**.
