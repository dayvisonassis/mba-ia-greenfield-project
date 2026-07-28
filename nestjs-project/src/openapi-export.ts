import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'node:fs';
import { AppModule } from './app.module';
import { buildSwaggerDocument } from './swagger/swagger-document';

/**
 * MUST run from the compiled output (`nest build` → `node dist/openapi-export.js`),
 * never through ts-node.
 *
 * The `@nestjs/swagger` CLI plugin that infers request-DTO schemas from their
 * class-validator decorators is declared in `nest-cli.json`, so it only applies
 * to code compiled by `nest build`/`nest start`. Running this file with ts-node
 * skips the plugin and silently emits a spec whose request bodies are empty
 * objects — a contract that says `POST /videos` accepts anything.
 */

export async function exportSpec(outputPath = 'openapi.json'): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const document = buildSwaggerDocument(app);
  writeFileSync(outputPath, JSON.stringify(document, null, 2));
  await app.close();
}

if (require.main === module) {
  void exportSpec();
}
