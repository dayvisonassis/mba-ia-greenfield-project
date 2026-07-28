---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: nestjs-project/test/videos-initiate-upload.e2e-spec.ts
---

# Endpoint `POST /videos` Test Plan

## Application Overview

`POST /videos` inicia o upload de um vídeo. Recebe apenas a **declaração** do cliente — nome do arquivo, mime e tamanho — valida essa declaração contra o allowlist e o teto de 10 GiB, cria a linha do vídeo em `uploading`/`draft` sob o canal do usuário autenticado, abre um multipart no object storage e devolve uma URL pré-assinada por parte. Nenhum byte do arquivo transita pelo processo Node: o cliente escreve direto no storage usando as URLs devolvidas.

## Test Scenarios

### 1. Autenticação

**Setup:** `beforeEach` trunca as tabelas do banco de teste; bootstrap do módulo via `Test.createTestingModule(...).compile()` reproduzindo a config global do `main.ts` (`ValidationPipe` e filtro de exceções de domínio globais — `Test.createTestingModule` não executa o `main.ts`).

#### 1.1. sem-token-retorna-401

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. `POST /videos` sem header `Authorization`, com body válido
    - expect: status `401`
    - expect: nenhuma linha criada na tabela `videos`

### 2. Iniciação bem-sucedida

**Setup:** herda o Setup do grupo 1; além disso, um usuário confirmado com seu canal é semeado e autenticado, e o MinIO real do Compose está disponível.

#### 2.1. body-valido-retorna-201-com-partes-pre-assinadas

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. `POST /videos` com `original_filename`, `declared_mime: "video/mp4"` e `declared_size_bytes` dentro do teto, autenticado
    - expect: status `201`
    - expect: body contém `id`, `slug`, `upload_id`, `part_size_bytes`, `parts` e `expires_in`
    - expect: `parts` é array não-vazio, cada item com `part_number` e `url`
    - expect: `part_size_bytes` ≥ 5 MiB (piso do protocolo multipart)
    - expect: a soma da capacidade das partes cobre o `declared_size_bytes` informado
    - expect: nenhuma `url` de `parts` contém o nome de serviço do Compose — todas apontam para o endpoint público
    - expect: a linha em `videos` está com `processing_status: "uploading"`, `visibility: "draft"` e `upload_id` não nulo

#### 2.2. webm-tambem-e-aceito

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. `POST /videos` com `declared_mime: "video/webm"`, autenticado
    - expect: status `201`
    - expect: a linha é criada — o allowlist aceita os dois contêineres, não só mp4

#### 2.3. channel-id-no-body-e-ignorado

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. Semear um segundo usuário com seu próprio canal
  2. `POST /videos` autenticado como o primeiro usuário, incluindo `channel_id` do **segundo** canal no body
    - expect: status `201`
    - expect: o vídeo criado pertence ao canal do usuário do token, não ao `channel_id` enviado no body

### 3. Rejeição por política de input

**Setup:** herda o Setup do grupo 2.

#### 3.1. mime-fora-do-allowlist-retorna-400

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. `POST /videos` com `declared_mime: "video/x-matroska"`, autenticado
    - expect: status `400`
    - expect: body no envelope `{ statusCode, error, message }` com `error: "UNSUPPORTED_VIDEO_FORMAT"`
    - expect: nenhuma linha criada em `videos`
    - expect: nenhum multipart aberto no storage

#### 3.2. tamanho-acima-do-teto-retorna-400

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. `POST /videos` com `declared_size_bytes` acima de 10737418240 (10 GiB), autenticado
    - expect: status `400`
    - expect: `error: "VIDEO_TOO_LARGE"`
    - expect: nenhuma linha criada em `videos`

### 4. Validação de schema

**Setup:** herda o Setup do grupo 2.

#### 4.1. campo-obrigatorio-ausente-retorna-400-de-validacao

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-07-27T02:49:14Z

**Steps:**
  1. `POST /videos` sem `declared_mime`, autenticado
    - expect: status `400`
    - expect: body no envelope `{ statusCode, error, message }` — a mesma forma dos erros de domínio
    - expect: `message` menciona o campo ausente
  2. `POST /videos` com `declared_size_bytes: 0`, autenticado
    - expect: status `400` — o valor precisa ser maior que zero
