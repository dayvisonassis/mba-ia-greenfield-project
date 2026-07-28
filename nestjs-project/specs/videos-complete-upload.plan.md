---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: nestjs-project/test/videos-complete-upload.e2e-spec.ts
---

# Endpoint `POST /videos/:id/complete` Test Plan

## Application Overview

`POST /videos/:id/complete` fecha o multipart upload com os `ETag` que o cliente coletou ao enviar cada parte diretamente ao storage. Verifica a propriedade do vídeo, confirma o multipart no storage, move `processing_status` de `uploading` para `processing` dentro de uma transação e **só depois do commit** enfileira o job `process-video`. Responde `202` porque o processamento continua em segundo plano — o resultado é observável depois via `GET /videos/:slug`.

## Test Scenarios

### 1. Autenticação e propriedade

**Setup:** `beforeEach` trunca as tabelas do banco de teste; bootstrap do módulo via `Test.createTestingModule(...).compile()` reproduzindo a config global do `main.ts`; MinIO e Redis reais do Compose disponíveis. Um helper semeia um vídeo em `uploading` com multipart aberto e partes já enviadas ao storage.

#### 1.1. sem-token-retorna-401

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. `POST /videos/:id/complete` sem header `Authorization`, com body válido
    - expect: status `401`
    - expect: o vídeo permanece em `processing_status: "uploading"`
    - expect: nenhum job na fila `video-processing`

#### 1.2. video-de-outro-canal-retorna-404

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. Semear dois usuários, cada um com seu canal; criar um vídeo em `uploading` sob o canal do usuário B
  2. `POST /videos/:id/complete` autenticado como usuário **A**, apontando para o vídeo de **B**
    - expect: status `404`
    - expect: `error: "VIDEO_NOT_FOUND"` — nunca `403`, que confirmaria a existência do recurso
    - expect: o vídeo de B permanece em `uploading`, com `upload_id` intacto
    - expect: nenhum job na fila

### 2. Conclusão bem-sucedida

**Setup:** herda o Setup do grupo 1; o vídeo semeado pertence ao usuário autenticado e suas partes já estão no storage com `ETag` conhecidos.

#### 2.1. partes-validas-retorna-202-e-enfileira

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. `POST /videos/:id/complete` com o array `parts` contendo `part_number` e `etag` de cada parte enviada, autenticado como dono
    - expect: status `202`
    - expect: body contém `id`, `slug` e `processing_status: "processing"`
    - expect: a linha em `videos` está em `processing` com `upload_id` nulo
    - expect: o objeto `{id}/source` existe íntegro no bucket de vídeos
    - expect: existe exatamente um job `process-video` na fila com payload `{ videoId }`

#### 2.2. job-so-existe-depois-do-commit

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. `POST /videos/:id/complete` válido, autenticado como dono
    - expect: quando o job está visível na fila, a linha do vídeo já está comitada em `processing` — um consumidor que leia o `videoId` do job encontra a linha no banco
    - expect: o job não é observável na fila antes do commit da transação

### 3. Estado inválido e partes inválidas

**Setup:** herda o Setup do grupo 2.

#### 3.1. concluir-duas-vezes-retorna-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. `POST /videos/:id/complete` válido, autenticado como dono
    - expect: status `202`
  2. `POST /videos/:id/complete` novamente, mesmo `id` e mesmo body
    - expect: status `409`
    - expect: `error: "INVALID_UPLOAD_STATE"`
    - expect: continua existindo apenas **um** job na fila — a segunda chamada não enfileira de novo

#### 3.2. etag-divergente-retorna-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. `POST /videos/:id/complete` com um `etag` propositalmente incorreto para uma das partes, autenticado como dono
    - expect: status `409`
    - expect: `error: "INVALID_UPLOAD_PARTS"`
    - expect: o vídeo **não** avança para `processing`
    - expect: nenhum job na fila

### 4. Validação de schema

**Setup:** herda o Setup do grupo 2.

#### 4.1. id-invalido-e-parts-vazio-retornam-400

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. `POST /videos/nao-e-uuid/complete` com body válido, autenticado
    - expect: status `400`
    - expect: body no envelope `{ statusCode, error, message }`
  2. `POST /videos/:id/complete` com `parts: []`, autenticado como dono
    - expect: status `400` — o array precisa de ao menos uma parte
