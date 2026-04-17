#!/usr/bin/env node
/**
 * CLI entry point for the coding agent.
 *
 * Dispatches to the v8 coordinator (coordinator.ts), which:
 *  - passes straight through to main() in interactive or non-tau use,
 *  - wraps main() with pre-localization + shape prediction + post-process
 *    when running inside the tau validator sandbox (TAU_REPO_DIR set).
 *
 * Legacy ensemble behavior is preserved: setting NINJA_ENSEMBLE_N > 1
 * routes through the old ensemble coordinator for A/B experiments.
 */
process.title = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { runCoordinatorOrSingle } from "./coordinator.js";
import { main } from "./main.js";

setGlobalDispatcher(new EnvHttpProxyAgent());

runCoordinatorOrSingle(process.argv.slice(2), main).catch((err) => {
	process.stderr.write(`[cli] fatal: ${err?.stack ?? err}\n`);
	process.exit(1);
});
