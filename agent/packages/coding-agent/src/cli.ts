#!/usr/bin/env node
/**
 * CLI entry point for the coding agent.
 *
 * In a normal interactive session this just dispatches to main(). When running
 * inside a tau duel sandbox (TAU_REPO_DIR set) or when the NINJA_ENSEMBLE_N
 * env var is > 1, we wrap main() in a self-consistency ensemble that runs N
 * child invocations of this same CLI, snapshots the working tree between
 * runs, and fuses the results with a per-file consensus vote before exiting.
 * See ensemble.ts for the full rationale.
 */
process.title = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { runEnsembleOrSingle } from "./ensemble.js";
import { main } from "./main.js";

setGlobalDispatcher(new EnvHttpProxyAgent());

runEnsembleOrSingle(process.argv.slice(2), main).catch((err) => {
	process.stderr.write(`[cli] fatal: ${err?.stack ?? err}\n`);
	process.exit(1);
});
