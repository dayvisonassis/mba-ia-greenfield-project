---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.13
target_file: nestjs-project/test/videos-delivery.e2e-spec.ts
---

# Endpoints de leitura e entrega Test Plan

## Application Overview

Três rotas sobre o mesmo recurso. `GET /videos/:slug` devolve o estado e os metadados do próprio vídeo — é o complemento observável do `202` da conclusão de upload, sem o qual o cliente não sabe que o processamento terminou. `GET /videos/:slug/stream` e `GET /videos/:slug/download` emitem `302` para uma URL pré-assinada de `GET` no storage: a API nunca intermedia bytes, e `Range`/`206` fica com o S3/MinIO. Nesta fase todo vídeo permanece `draft`, então as três rotas são restritas ao dono autenticado.

## Test Scenarios

### 1. Autenticação e propriedade

**Setup:** `beforeEach` trunca as tabelas do banco de teste; bootstrap do módulo via `Test.createTestingModule(...).compile()` reproduzindo a config global do `main.ts`; MinIO real do Compose disponível. Helpers semeiam um vídeo em `ready` com objeto `{id}/source` no bucket, e vídeos nos demais estados.

#### 1.1. as-tres-rotas-sem-token-retornam-401

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. `GET /videos/:slug` sem header `Authorization`
    - expect: status `401`
  2. `GET /videos/:slug/stream` sem header `Authorization`
    - expect: status `401`
  3. `GET /videos/:slug/download` sem header `Authorization`
    - expect: status `401`

#### 1.2. video-de-outro-canal-e-indistinguivel-de-inexistente

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. Semear dois usuários, cada um com seu canal; criar um vídeo `ready` sob o canal do usuário B
  2. `GET /videos/:slug` autenticado como usuário **A**, com o slug do vídeo de **B**
    - expect: status `404`
    - expect: `error: "VIDEO_NOT_FOUND"` — nunca `403`
  3. `GET /videos/:slug` autenticado como A, com um slug que não existe em nenhum canal
    - expect: status `404` e `error: "VIDEO_NOT_FOUND"` — resposta **byte-idêntica** à do passo 2, para não permitir enumeração de slugs de terceiros

### 2. Leitura do próprio vídeo

**Setup:** herda o Setup do grupo 1; o usuário autenticado é dono dos vídeos semeados.

#### 2.1. video-ready-retorna-200-com-metadados

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. `GET /videos/:slug` de um vídeo `ready`, autenticado como dono
    - expect: status `200`
    - expect: body contém `id`, `slug`, `original_filename`, `processing_status: "ready"`, `visibility: "draft"`
    - expect: `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `format_name`, `size_bytes` e `bitrate` estão preenchidos
    - expect: body **não** contém bytes do vídeo nem a chave interna do objeto no storage

#### 2.2. video-em-processing-retorna-200-com-metadados-nulos

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. `GET /videos/:slug` de um vídeo em `processing`, autenticado como dono
    - expect: status `200`
    - expect: `processing_status: "processing"`
    - expect: os oito campos de metadados são `null` — o processamento ainda não os gravou

#### 2.3. video-failed-expoe-o-motivo

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. `GET /videos/:slug` de um vídeo em `failed`, autenticado como dono
    - expect: status `200`
    - expect: `processing_status: "failed"` e `failure_reason` não nulo — é por aqui que a falha do worker chega ao cliente, não por status code

### 3. Streaming

**Setup:** herda o Setup do grupo 2.

#### 3.1. stream-de-video-ready-redireciona-e-entrega

**Covers AC:** #4, #7
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. `GET /videos/:slug/stream` de um vídeo `ready`, autenticado como dono, sem seguir redirect
    - expect: status `302`
    - expect: header `Location` presente, apontando para o endpoint público do storage — **não** para o nome de serviço do Compose
    - expect: o corpo da resposta da API está vazio — nenhum byte do vídeo passa pela API
  2. Seguir o `Location` com uma requisição `GET` direta ao storage
    - expect: status `200` e o conteúdo do objeto é entregue
  3. Seguir o `Location` enviando header `Range: bytes=0-1023`
    - expect: status `206` e apenas o trecho solicitado é devolvido — o `Range` é honrado pelo storage

#### 3.2. stream-de-video-nao-processado-retorna-409

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. `GET /videos/:slug/stream` de um vídeo em `processing`, autenticado como dono
    - expect: status `409`
    - expect: `error: "VIDEO_NOT_READY"`
    - expect: nenhum header `Location` na resposta
  2. `GET /videos/:slug/stream` de um vídeo em `uploading`, autenticado como dono
    - expect: status `409` e `error: "VIDEO_NOT_READY"`
  3. `GET /videos/:slug/stream` de um vídeo em `failed`, autenticado como dono
    - expect: status `409`
    - expect: `error: "VIDEO_PROCESSING_FAILED"` — distinto de `VIDEO_NOT_READY`

### 4. Download

**Setup:** herda o Setup do grupo 2.

#### 4.1. download-de-video-ready-entrega-como-anexo

**Covers AC:** #6, #7
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. `GET /videos/:slug/download` de um vídeo `ready`, autenticado como dono, sem seguir redirect
    - expect: status `302`
    - expect: header `Location` presente
    - expect: o corpo da resposta da API está vazio
  2. Seguir o `Location` com uma requisição `GET` direta ao storage
    - expect: status `200`
    - expect: header `Content-Disposition` com `attachment` e o `original_filename` do vídeo

#### 4.2. download-de-video-nao-processado-retorna-409

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. `GET /videos/:slug/download` de um vídeo em `processing`, autenticado como dono
    - expect: status `409` e `error: "VIDEO_NOT_READY"`
  2. `GET /videos/:slug/download` de um vídeo em `failed`, autenticado como dono
    - expect: status `409` e `error: "VIDEO_PROCESSING_FAILED"`
