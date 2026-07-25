#!/usr/bin/env node
/**
 * Quality gate orchestrator — see GATES.md.
 *
 * Runs the deterministic checks behind the Definition of Done (root CLAUDE.md)
 * cheapest-first, stops at the first failure, and exits non-zero.
 *
 *   node scripts/run-gate.mjs                 # every gate
 *   node scripts/run-gate.mjs backend         # backend only
 *   node scripts/run-gate.mjs frontend        # frontend only
 *   node scripts/run-gate.mjs lint-backend    # one gate
 *   node scripts/run-gate.mjs --with-e2e      # include the backend e2e gate
 *
 * Every command runs inside its container: node_modules lives in a named volume
 * and is not present on the host, and `docker compose exec` without -T would
 * allocate a TTY and hang here.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Ordered cheapest-first: a typecheck failure costs seconds, a suite costs minutes. */
const GATES = [
  { id: "typecheck-backend",  scope: "backend",  dir: "nestjs-project", service: "nestjs-api",     cmd: ["npx", "tsc", "--noEmit"] },
  { id: "typecheck-frontend", scope: "frontend", dir: "next-frontend",  service: "next-frontend",  cmd: ["npx", "tsc", "--noEmit"] },
  { id: "lint-backend",       scope: "backend",  dir: "nestjs-project", service: "nestjs-api",     cmd: ["npm", "run", "lint"] },
  { id: "lint-frontend",      scope: "frontend", dir: "next-frontend",  service: "next-frontend",  cmd: ["npm", "run", "lint"] },
  { id: "tests-backend",      scope: "backend",  dir: "nestjs-project", service: "nestjs-api",     cmd: ["npm", "test", "--", "--runInBand"] },
  { id: "tests-frontend",     scope: "frontend", dir: "next-frontend",  service: "next-frontend",  cmd: ["npm", "test"] },
  // Opt-in: slower, and it rebuilds the test database.
  { id: "e2e-backend",        scope: "backend",  dir: "nestjs-project", service: "nestjs-api",     cmd: ["npm", "run", "test:e2e"], optIn: true },
];

const args = process.argv.slice(2);
const withE2e = args.includes("--with-e2e");
const selector = args.find((a) => !a.startsWith("--"));

const selected = GATES.filter((g) => {
  if (g.optIn && !withE2e && selector !== g.id) return false;
  if (!selector) return true;
  return g.scope === selector || g.id === selector;
});

if (selected.length === 0) {
  console.error(`No gate matches "${selector}".`);
  console.error(`Known ids: ${GATES.map((g) => g.id).join(", ")}`);
  console.error(`Scopes: backend, frontend`);
  process.exit(2);
}

/** A container that is not running must report "not run", never a pass. */
function containerIsUp(dir, service) {
  const res = spawnSync("docker", ["compose", "ps", "--status", "running", "--format", "{{.Service}}"], {
    cwd: resolve(ROOT, dir),
    encoding: "utf8",
    shell: false,
  });
  return res.status === 0 && res.stdout.split("\n").some((l) => l.trim() === service);
}

let failed = null;
const results = [];

for (const gate of selected) {
  process.stdout.write(`▶ ${gate.id} … `);

  if (!containerIsUp(gate.dir, gate.service)) {
    console.log("NOT RUN");
    console.error(`\n  Container "${gate.service}" is not running.`);
    console.error(`  Start it with:  cd ${gate.dir} && docker compose up -d\n`);
    results.push({ id: gate.id, status: "not run" });
    failed = gate.id;
    break;
  }

  const started = Date.now();
  const res = spawnSync("docker", ["compose", "exec", "-T", gate.service, ...gate.cmd], {
    cwd: resolve(ROOT, gate.dir),
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: false,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (res.status === 0) {
    console.log(`PASS (${seconds}s)`);
    results.push({ id: gate.id, status: "pass", seconds });
  } else {
    console.log(`FAIL (${seconds}s)`);
    console.error(`\n${res.stdout ?? ""}${res.stderr ?? ""}\n`);
    results.push({ id: gate.id, status: "fail", seconds });
    failed = gate.id;
    break; // stop at the first failure — later gates would only add noise
  }
}

const passed = results.filter((r) => r.status === "pass").length;
console.log(
  `\n${passed}/${selected.length} gates passed` +
    (failed ? ` — stopped at ${failed}` : "") +
    ".",
);

process.exit(failed ? 1 : 0);
