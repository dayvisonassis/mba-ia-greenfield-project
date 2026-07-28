# StreamTube — Plataforma de Compartilhamento de Vídeos

Projeto da disciplina **Desenvolvimento de Aplicações de IA** do MBA de Engenharia de Software com IA da [Full Cycle](https://fullcycle.com.br).

Este é um projeto greenfield desenvolvido para demonstrar como construir uma aplicação do zero utilizando IA de forma adequada no processo de desenvolvimento.

## Professor

<a href="https://github.com/argentinaluiz">
    <img src="https://avatars.githubusercontent.com/u/4926329?v=4?s=100" width="100px;" alt=""/>
    <br />
    <sub>
        <b>Luiz Carlos</b>
    </sub>
</a>

---

## Quadro Branco

- [Quadro Branco](./whiteboard.png)

---

## 🎨 Design System (Figma)

- [FC Tube.fig](./FC%20Tube.fig) — arquivo-fonte do **design system** do projeto no Figma.

Contém os fundamentos visuais do StreamTube — tokens (cores, tipografia, espaçamento, raios), componentes e as telas da plataforma. É a referência de design para a implementação do frontend: os componentes em `next-frontend/components/ui` (shadcn) e os tokens em `next-frontend/app/globals.css` derivam deste arquivo. Abra-o no Figma (`Arquivo → Importar`) para consultar especificações e estados visuais.

---

## 📋 Pré-requisitos

- Docker e Docker Compose
- Node.js v25+ (para rodar os testes E2E do Playwright no host)
- npm

## 🏗️ Arquitetura

O projeto é um monorepo baseado em containers Docker. Cada subprojeto sobe sua própria stack via `docker compose`.

- **Frontend** (Next.js 16, App Router + React Server Components) — interface da plataforma. Segue o **modelo BFF**: o navegador nunca chama a API NestJS diretamente; todo tráfego passa por Route Handlers same-origin em `app/api/**`, que fazem proxy server-side para a API.
- **API** (NestJS 11) — regras de negócio, autenticação (JWT + refresh token rotation), envio de e-mails e acesso ao banco.
- **Database** (PostgreSQL 17) — usuários, canais, vídeos e tokens de autenticação.
- **Email Service** (Mailpit) — captura os e-mails transacionais (confirmação de conta e recuperação de senha) em uma UI local.
- **Video Worker** (FFmpeg) — consome a fila `video-processing`, extrai metadados com `ffprobe`, gera a thumbnail com `ffmpeg` e marca o vídeo como `ready` ou `failed`. Roda como *application context* do Nest, sem porta HTTP.
- **Object Storage** (MinIO, S3-compatível) — arquivos de vídeo e thumbnails, em buckets privados. O byte do vídeo **nunca passa pela API**: o cliente sobe direto por URLs pré-assinadas de multipart upload e assiste por redirect para uma URL pré-assinada de leitura.
- **Message Queue** (Redis + BullMQ) — fila `video-processing`, com AOF habilitado.

O diagrama de arquitetura completo (C4) está em `docs/diagrams/software-arch.mermaid`.

## 🚀 Como rodar

Os dois subprojetos têm stacks Docker **separadas**. Suba primeiro o backend, rode as migrations e depois o frontend.

### 1. Backend (NestJS + PostgreSQL + Mailpit + Redis + MinIO + Worker)

```bash
cd nestjs-project

# Sobe API, banco, Mailpit, Redis, MinIO e o worker de vídeo
docker compose up -d

# Instala dependências (apenas na primeira vez) — o volume de node_modules
# é compartilhado com o video-worker, então um install serve para os dois
docker compose exec nestjs-api npm install

# Cria o schema do banco (obrigatório — synchronize está desabilitado)
docker compose exec nestjs-api npm run migration:run

# Sobe o servidor de desenvolvimento em watch mode
docker compose exec -d nestjs-api npm run start:dev

# Sobe o worker de vídeo em watch mode
docker compose exec -d video-worker npm run start:worker
```

Serviços disponíveis:

| Serviço | URL / Porta |
|---------|-------------|
| API NestJS | http://localhost:3000 |
| PostgreSQL | `localhost:5432` (user/senha: `streamtube`; bancos `streamtube` e `streamtube_test`) |
| Mailpit (UI de e-mails) | http://localhost:8025 |
| Redis (fila BullMQ) | `localhost:6379` |
| MinIO (API S3) | http://localhost:9000 — buckets privados `streamtube-videos` e `streamtube-thumbnails` |
| MinIO (console) | http://localhost:9001 (user/senha: `streamtube`) |
| Video Worker | sem porta — consome a fila `video-processing` |
| Swagger (opcional) | http://localhost:3000/api/docs — habilite com `SWAGGER_ENABLED=true` |

> O backend usa dois **volumes Docker nomeados**, fora do bind mount: `nestjs_node_modules` (lê-lo através do bind mount no Windows custava ~12s só para `require('@nestjs/core')`) e `streamtube_pgdata` (os dados do Postgres). Consequências: o `node_modules` não é visível no host, então todo `npm`/`npx` roda dentro do container — depois de alterar o `package.json`, rode `docker compose exec nestjs-api npm install`. Os dados do banco sobrevivem a `docker compose down`; só `docker compose down -v` ou `docker volume prune` os destroem.

### 2. Frontend (Next.js)

```bash
cd next-frontend

# Garanta que o .env.local existe (veja .env.example)
# API_URL aponta para o backend; SESSION_PASSWORD protege a sessão (iron-session)

docker compose up -d
docker compose exec next-frontend npm install        # apenas na primeira vez
docker compose exec -d next-frontend npm run dev
```

A aplicação ficará disponível em **http://localhost:3001**.

> As stacks são separadas, então o frontend acessa o backend via `host.docker.internal:3000` (configurado em `next-frontend/.env.local` e no `extra_hosts` do compose).

## ✅ Quality Gates

Os checks determinísticos por trás da Definition of Done rodam por um único ponto de entrada:

```bash
node scripts/run-gate.mjs              # typecheck + lint + testes, nos dois subprojetos e no worker
node scripts/run-gate.mjs backend      # só o backend
node scripts/run-gate.mjs worker       # só o worker de vídeo (FFmpeg + specs dos processors)
node scripts/run-gate.mjs --with-e2e   # inclui o e2e do backend
```

Roda do mais barato ao mais caro e para no primeiro erro. Detalhes em [GATES.md](./GATES.md).

## 🧪 Testes

### Backend (Jest)

```bash
cd nestjs-project
docker compose exec nestjs-api npm test               # unitários + integração
docker compose exec nestjs-api npm run test:e2e       # end-to-end (HTTP via supertest)
docker compose exec nestjs-api npm run test:cov       # cobertura
```

Sufixos: `*.spec.ts` (unitário), `*.integration-spec.ts` (integração com banco real), `*.e2e-spec.ts` (end-to-end). Testes de integração/e2e rodam com `--runInBand`.

Os testes **nunca tocam o banco de desenvolvimento**: os scripts apontam para `streamtube_test` via `.env.test`, e o `test/global-setup.ts` cria e migra esse banco automaticamente antes da suíte.

### Frontend (Vitest + Playwright)

```bash
cd next-frontend
docker compose exec next-frontend npm test            # unitários + integração (Vitest + MSW)
npx playwright test                                   # end-to-end (no host, com dev server em MSW_ENABLED=true)
```

Sufixos: `*.test.ts(x)` (unitário), `*.integration.test.ts(x)` (Route Handlers com MSW), `*.e2e-spec.ts` (Playwright). MSW intercepta as chamadas à API NestJS — os testes nunca batem no backend real.

## ✅ Funcionalidades implementadas

**Fase 01 — Configuração base** e **Fase 02 — Autenticação** estão concluídas (backend + frontend). A **Fase 03 — Upload e Processamento de Vídeos** está concluída no backend.

### Autenticação (Fase 02)

Fluxo completo de **cadastro → confirmação por e-mail → login → recuperação de senha**, com canal criado automaticamente para cada usuário (a partir do prefixo do e-mail).

Endpoints da API (`nestjs-project`):

| Método & Rota | Descrição |
|---------------|-----------|
| `POST /auth/register` | Cadastro de usuário (cria usuário + canal) |
| `GET /auth/confirm-email?token=` | Confirmação de conta via link do e-mail |
| `POST /auth/resend-confirmation` | Reenvio do e-mail de confirmação |
| `POST /auth/login` | Login (retorna access + refresh token) |
| `POST /auth/refresh` | Rotação de refresh token (com family + grace period) |
| `POST /auth/logout` | Revoga os refresh tokens da sessão |
| `POST /auth/forgot-password` | Solicita e-mail de recuperação de senha |
| `POST /auth/reset-password` | Redefine a senha via token |
| `GET /auth/me` | Dados do usuário autenticado (protegido por JWT) |

Telas e Route Handlers BFF (`next-frontend`):

- `/(auth)/signup`, `/(auth)/login`, `/(auth)/forgot-password` — formulários com React Hook Form + Zod e validação inline.
- `app/api/auth/{signup,login,logout,forgot-password}` — proxy same-origin para a API.

Segurança: senhas com **Argon2**, **JWT** com `JwtAuthGuard` global (opt-out via `@Public()`), **rotação de refresh token** com detecção de reuso, **rate limiting** (`ThrottlerGuard`) nos endpoints de auth, e sessão no navegador via **iron-session** (cookies HTTP-only).

### Vídeos (Fase 03)

Ciclo completo de **upload direto ao storage → processamento assíncrono → entrega por URL pré-assinada**, aceitando arquivos de até **10 GiB** nos formatos `video/mp4` e `video/webm`.

Endpoints da API (`nestjs-project`) — todos exigem autenticação e operam sobre o canal do token:

| Método & Rota | Descrição |
|---------------|-----------|
| `POST /videos` | Inicia o upload: cria o vídeo em `draft`/`uploading`, abre o multipart no storage e devolve uma URL pré-assinada por parte |
| `POST /videos/:id/complete` | Fecha o multipart com os `ETag` coletados, marca `processing` e enfileira o job (`202`) |
| `GET /videos/:slug` | Estado e metadados do próprio vídeo — é como o cliente descobre que o processamento terminou |
| `GET /videos/:slug/stream` | `302` para URL pré-assinada de leitura; `Range`/`206` ficam com o storage |
| `GET /videos/:slug/download` | `302` para URL pré-assinada com `Content-Disposition: attachment` |

Como o arquivo de 10 GiB não derruba a API: **nenhum byte de vídeo passa pelo processo Node**. O cliente faz `PUT` de cada parte direto nas URLs pré-assinadas do MinIO, e a entrega é um redirect — quem lida com `Range`, `206` e streaming é o storage.

Processamento: o `video-worker` consome a fila `video-processing` (BullMQ/Redis), baixa o objeto, lê os metadados com `ffprobe` (duração, resolução, codecs, container, bitrate), corta a thumbnail com `ffmpeg` e grava o resultado. Container não suportado ou arquivo sem trilha de vídeo viram falha permanente com `failure_reason` — sem retry inútil. O job só é enfileirado **depois** do commit da transação, então o worker nunca lê uma linha que ainda não existe.

Acesso: um slug de outro canal responde exatamente como um slug inexistente (`404 VIDEO_NOT_FOUND`), o que impede enumerar vídeos alheios. As URLs de entrega expiram em minutos — com entrega por redirect, a janela temporal **é** o controle de acesso.

## 🛠️ Estrutura do Projeto

```
green-field-ia-project/
├── docs/
│   ├── project-plan.md                  # Planejamento geral do projeto
│   ├── phases/                          # Planos e implementação por fase
│   │   ├── phase-01-configuracao-base/
│   │   ├── phase-02-auth/               # Auth (backend)
│   │   ├── phase-02-auth-frontend/      # Auth (frontend)
│   │   └── phase-03-videos/             # Upload e processamento de vídeos
│   ├── decisions/                       # Decisões técnicas (TDs) por escopo
│   └── diagrams/
│       └── software-arch.mermaid        # Diagrama de arquitetura (C4)
├── nestjs-project/                      # Backend API (NestJS 11)
│   ├── src/
│   │   ├── auth/                        # Cadastro, login, JWT, refresh, reset de senha
│   │   ├── users/                       # Entidade e serviço de usuários
│   │   ├── channels/                    # Canal 1:1 por usuário (nickname do e-mail)
│   │   ├── videos/                      # Upload, entrega e processadores do worker
│   │   ├── storage/                     # Cliente S3/MinIO (multipart, presign, buckets)
│   │   ├── mail/                        # Envio de e-mails (templates Handlebars)
│   │   ├── common/                      # Filtros, pipes e exceptions de domínio
│   │   ├── config/                      # Configs namespaced (Joi)
│   │   ├── database/                    # data-source, migrations e seeds
│   │   └── worker.ts                    # Entrypoint do video-worker (application context)
│   ├── specs/                           # Specs de teste E2E derivados do plano
│   ├── test/                            # Testes e2e
│   ├── openapi.json                     # Contrato OpenAPI versionado (gerado)
│   ├── compose.yaml                     # Compose (API + Postgres + Mailpit + Redis + MinIO + worker)
│   ├── Dockerfile.dev
│   └── Dockerfile.worker                # Imagem do worker (inclui FFmpeg)
├── next-frontend/                       # Frontend (Next.js 16, App Router)
│   ├── app/                             # Rotas, layouts, páginas e Route Handlers BFF
│   ├── components/                      # Componentes de auth, UI (shadcn) e ícones
│   ├── lib/                             # env, api (openapi-fetch), auth/session
│   ├── mocks/                           # MSW (handlers + server)
│   ├── tests/                           # E2E (Playwright)
│   ├── compose.yaml                     # Docker Compose (dev server)
│   └── Dockerfile.dev
├── CLAUDE.md                            # Instruções para IA
├── FC Tube.fig                          # Design system do projeto (Figma)
├── whiteboard.png                       # Quadro branco do projeto
└── README.md
```

## 📚 Fases do Projeto

| Fase | Descrição | Status |
|------|-----------|--------|
| **01** | Configuração Base do Projeto | ✅ Concluída |
| **02** | Cadastro, Login e Gerenciamento de Conta | ✅ Concluída |
| **03** | Upload e Processamento de Vídeos | ✅ Concluída (backend) |
| **04** | Gerenciamento de Vídeos e Canal | ⏳ Planejada |
| **05** | Página de Visualização do Vídeo | ⏳ Planejada |
| **06** | Interações Sociais (Likes, Comentários, Inscrições) | ⏳ Planejada |
| **07** | Página Inicial, Busca e Finalização | ⏳ Planejada |

Detalhes completos em `docs/project-plan.md`.

## 📖 Stack Tecnológica

| Camada | Tecnologia |
|--------|------------|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4, shadcn/ui, React Hook Form + Zod, iron-session, openapi-fetch |
| Backend | NestJS 11, TypeScript, TypeORM, JWT, Argon2, Mailer (Handlebars) |
| Banco de Dados | PostgreSQL 17 |
| Fila | Redis 8 + BullMQ |
| Object Storage | MinIO (S3-compatível), AWS SDK v3 |
| Processamento de vídeo | FFmpeg / ffprobe |
| E-mail (dev) | Mailpit |
| Containerização | Docker, Docker Compose |
| Testes | Jest, Supertest (backend); Vitest, MSW, Playwright (frontend) |
| Qualidade | ESLint, Prettier |
</content>
