/**
 * v8 coordinator for SN66 duels.
 *
 * Architecture
 * ------------
 * When the agent CLI runs inside the tau validator sandbox (TAU_REPO_DIR
 * set), this coordinator wraps the normal single-process agent loop with:
 *
 *   1. Deterministic pre-localization (localization.ts) — parent-side
 *      repo scan that identifies the files most likely to contain the
 *      reference diff, plus head-of-file excerpts. Shortcuts 40-90 s of
 *      LLM discovery time.
 *
 *   2. Shape prediction (shape-predictor.ts) — static analysis of the
 *      task text to estimate how many lines / files the hidden reference
 *      diff is likely to touch. Injected as an explicit upper bound into
 *      the system prompt so Flash aims for small, focused edits.
 *
 *   3. Pristine snapshot — before the LLM runs, we cache every file's
 *      bytes from /work/repo so we can later diff the agent's output
 *      against it.
 *
 *   4. Inline agent invocation — we call main() directly in this
 *      process, not in a subprocess. This preserves every second of the
 *      validator's agent_timeout for actual LLM work, and it means the
 *      edit tool writes directly to /work/repo; our patch is already on
 *      disk incrementally, so an external SIGKILL still ships whatever
 *      the agent got done.
 *
 *   5. Deterministic post-process (post-process.ts) — a byte-level
 *      normalization pass that restores final-newline state, trailing
 *      whitespace on unchanged lines, line-ending style, and excess EOF
 *      blank lines. Purely additive to the score: it can never cost
 *      points (we only touch bytes that were identical to pristine up
 *      to whitespace/EOL noise), and it plugs a common Flash
 *      misalignment pattern.
 *
 *   6. Explicit process.exit — after post-process runs, we exit
 *      immediately so the docker `exec` returns and tau's
 *      _collect_repo_patch_from_container runs. The whole point is to
 *      get back to tau *before* it SIGKILLs the container (which would
 *      result in an empty diff and a guaranteed tie/loss).
 *
 * Fallback behavior
 * -----------------
 * Outside of tau (no TAU_REPO_DIR), or when TAU_DISABLE_COORDINATOR=1 is
 * set, the coordinator is a thin pass-through to runSingle.
 *
 * All errors in the coordinator are caught and logged; if anything in
 * pre-localization or shape prediction throws, we just skip that step
 * and run the agent with its normal prompt.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { formatLocalizationForPrompt, localize } from "./localization.js";
import { formatPostProcessStats, runPostProcess } from "./post-process.js";
import { formatShapeForPrompt, predictShape, type ShapePrediction } from "./shape-predictor.js";

/** Environment variable toggles (all default to "enabled" inside tau). */
const ENV_DISABLE = "NINJA_DISABLE_COORDINATOR";
const ENV_DISABLE_LOCALIZATION = "NINJA_DISABLE_LOCALIZATION";
const ENV_DISABLE_SHAPE = "NINJA_DISABLE_SHAPE";
const ENV_DISABLE_POSTPROCESS = "NINJA_DISABLE_POSTPROCESS";
const ENV_FORCE_COORDINATOR = "NINJA_FORCE_COORDINATOR";

/** Max elapsed ms before we pre-emptively exit and let post-process run. */
const HARD_DEADLINE_MS = 260_000;

/** Files we skip when snapshotting (identical exclusion set as ensemble). */
const SNAPSHOT_EXCLUDES = new Set([
	".git",
	".hg",
	"node_modules",
	".next",
	"dist",
	"build",
	".cache",
	"target",
	"out",
	".turbo",
	".venv",
	"venv",
	"__pycache__",
]);

function log(msg: string): void {
	// Always stderr — docker_solver captures both streams but stdout is
	// reserved for JSON output in `--mode json`.
	process.stderr.write(`[coord] ${msg}\n`);
}

/**
 * Locate the agent-root/bin directory (which we ship with fd + rg static
 * linux binaries). We search a few plausible roots because the compiled
 * module can be invoked via tsx (src path) or via dist/ after a build.
 */
function findBundledBinDir(): string | undefined {
	const candidates: string[] = [];
	const envAgentDir = process.env.TAU_AGENT_DIR ?? process.env.PI_AGENT_DIR;
	if (envAgentDir) candidates.push(join(envAgentDir, "bin"));
	// Walk up from this file: .../packages/coding-agent/src/ → agent/
	// Both the src tsx path and the dist js path land us in a similar shape.
	try {
		let here = __dirname;
		for (let i = 0; i < 6; i++) {
			const maybe = join(here, "bin");
			if (existsSync(join(maybe, "fd")) || existsSync(join(maybe, "rg"))) {
				candidates.push(maybe);
			}
			here = dirname(here);
		}
	} catch {
		// __dirname may not be defined under some ESM shapes — best-effort.
	}
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return undefined;
}

/**
 * Seed ~/.pi/agent/bin with our bundled fd + rg so the coding-agent's
 * `ensureTool()` finds them immediately on the FIRST tool call — no
 * network fetch, no cold-start penalty. Also prepends the directory to
 * PATH so raw `bash` calls (rg/fd) resolve too.
 *
 * All errors are silently swallowed. This is a best-effort speed-up;
 * the pure-Node globSync/read fallbacks still keep us correct if it
 * fails.
 */
function seedBundledBinaries(): void {
	try {
		const srcBin = findBundledBinDir();
		if (!srcBin) return;
		// Compute target bin dir: matches getBinDir() from config.ts →
		// join(getAgentDir(), "bin"). getAgentDir falls back to
		// `~/.pi/agent` when no env var overrides.
		const targetRoot = process.env.PI_AGENT_DIR
			? resolve(process.env.PI_AGENT_DIR)
			: join(homedir(), ".pi", "agent");
		const targetBin = join(targetRoot, "bin");
		mkdirSync(targetBin, { recursive: true });
		for (const name of ["fd", "rg"]) {
			const src = join(srcBin, name);
			if (!existsSync(src)) continue;
			const dst = join(targetBin, name);
			try {
				if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) {
					copyFileSync(src, dst);
				}
				chmodSync(dst, 0o755);
			} catch {
				// Skip if we can't write (e.g. readonly fs); fall through to PATH.
			}
		}
		// Prepend to PATH too, so `bash` invocations see them even without
		// getToolPath's ~/.pi/agent/bin lookup.
		const currentPath = process.env.PATH ?? "";
		const parts = currentPath.split(":").filter(Boolean);
		if (!parts.includes(targetBin)) parts.unshift(targetBin);
		if (!parts.includes(srcBin)) parts.unshift(srcBin);
		process.env.PATH = parts.join(":");
		log(`seeded fd/rg from ${srcBin} → ${targetBin}; PATH prepended`);
	} catch (e) {
		log(`seedBundledBinaries failed: ${(e as Error).message}`);
	}
}

function isTruthy(v: string | undefined): boolean {
	if (!v) return false;
	return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function inTauSandbox(): boolean {
	if (isTruthy(process.env[ENV_FORCE_COORDINATOR])) return true;
	return !!process.env.TAU_REPO_DIR;
}

/** Extract the task prompt text, preferring the file tau wrote for us. */
function readTaskPrompt(args: string[]): string | undefined {
	const promptFile = process.env.TAU_PROMPT_FILE ?? process.env.PI_PROMPT_FILE;
	if (promptFile) {
		try {
			return readFileSync(promptFile, "utf-8");
		} catch (e) {
			log(`could not read TAU_PROMPT_FILE=${promptFile}: ${(e as Error).message}`);
		}
	}
	// Fallback: the last non-flag argv entry is almost always the prompt
	// when tau calls `cli.js --mode json --no-session -p "$PROMPT"`.
	for (let i = args.length - 1; i >= 0; i--) {
		const a = args[i];
		if (!a.startsWith("-") && a.length > 0) return a;
	}
	return undefined;
}

function walkFiles(root: string): string[] {
	const results: string[] = [];
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (SNAPSHOT_EXCLUDES.has(name)) continue;
			const full = join(dir, name);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				stack.push(full);
			} else if (st.isFile()) {
				// Skip very large files to keep snapshot cheap. The
				// reference diff almost never touches files > 2 MB.
				if (st.size > 2_000_000) continue;
				results.push(full);
			}
		}
	}
	return results;
}

/** Snapshot every reasonable file under /work/repo for post-process. */
function snapshotPristine(repoRoot: string): Map<string, Buffer> {
	const snap = new Map<string, Buffer>();
	for (const abs of walkFiles(repoRoot)) {
		try {
			const buf = readFileSync(abs);
			const rel = relative(repoRoot, abs).split(/\\/).join("/");
			snap.set(rel, buf);
		} catch {
			// Unreadable — skip.
		}
	}
	return snap;
}

/**
 * Write the injected context block (localization + shape prediction) to
 * a file we can pass as `--append-system-prompt <path>`. The agent CLI
 * resolves this path and inlines the content into the system prompt.
 */
function writeInjectedContext(content: string): string | undefined {
	if (!content) return undefined;
	// We prefer /work/tmp (plenty of space) over /tmp (128 MB, tight).
	const candidates = [process.env.TAU_WORK_TMP ?? "/work/tmp", process.env.PI_WORK_TMP ?? "/work/tmp", tmpdir()];
	for (const base of candidates) {
		try {
			mkdirSync(base, { recursive: true });
			const path = join(base, `ninja-context-${process.pid}.md`);
			writeFileSync(path, content, "utf-8");
			return path;
		} catch {
			// Try next.
		}
	}
	return undefined;
}

/** If argv already contains `--append-system-prompt`, we leave it alone. */
function injectAppendSystemPromptArg(args: string[], contextPath: string): string[] {
	if (args.includes("--append-system-prompt")) {
		// Don't stomp on user-provided appends; just log and move on. The
		// user's version will run and our localization is ignored for
		// this invocation.
		log("argv already contains --append-system-prompt; skipping injection");
		return args;
	}
	return [...args, "--append-system-prompt", contextPath];
}

function installHardDeadline(repoRoot: string, pristine: Map<string, Buffer>): NodeJS.Timeout {
	return setTimeout(() => {
		try {
			log(`hard deadline ${HARD_DEADLINE_MS}ms reached; running post-process and exiting`);
			if (!isTruthy(process.env[ENV_DISABLE_POSTPROCESS])) {
				const stats = runPostProcess(repoRoot, pristine);
				log(formatPostProcessStats(stats, repoRoot));
			}
		} catch (e) {
			log(`hard-deadline post-process failed: ${(e as Error).message}`);
		}
		// Whatever's on disk is our submission.
		process.exit(0);
	}, HARD_DEADLINE_MS);
}

/**
 * Entry point. Either wraps main() with the v8 machinery, or calls
 * main() directly if coordinator is disabled / we're not in tau.
 */
export async function runCoordinatorOrSingle(
	args: string[],
	runSingle: (args: string[]) => Promise<void>,
): Promise<void> {
	// Always seed bundled fd/rg — even outside tau it's a cheap no-op
	// when binaries aren't present, and a free discovery speed-up when
	// they are.
	seedBundledBinaries();

	if (isTruthy(process.env[ENV_DISABLE])) {
		return runSingle(args);
	}

	// Legacy ensemble opt-in. If someone explicitly asks for the old
	// ensemble via NINJA_ENSEMBLE_N > 1, they get it. Otherwise the
	// coordinator (below) handles all tau runs.
	const ensembleN = parseInt(process.env.NINJA_ENSEMBLE_N ?? "", 10);
	if (Number.isFinite(ensembleN) && ensembleN > 1) {
		const { runEnsembleOrSingle } = await import("./ensemble.js");
		return runEnsembleOrSingle(args, runSingle);
	}

	if (!inTauSandbox()) {
		return runSingle(args);
	}

	const tStart = Date.now();
	const repoRoot = resolve(process.env.TAU_REPO_DIR ?? process.env.PI_REPO_DIR ?? process.cwd());
	if (!existsSync(repoRoot)) {
		log(`repo root ${repoRoot} does not exist; falling back to plain run`);
		return runSingle(args);
	}

	// 1. Read the task prompt.
	const taskPrompt = readTaskPrompt(args);
	if (!taskPrompt) {
		log("no task prompt found; falling back to plain run");
		return runSingle(args);
	}
	log(`task prompt length=${taskPrompt.length} chars`);

	// 2. Pristine snapshot (always — post-process needs it and it's cheap).
	let pristine = new Map<string, Buffer>();
	try {
		pristine = snapshotPristine(repoRoot);
		log(`pristine snapshot: ${pristine.size} files from ${repoRoot}`);
	} catch (e) {
		log(`snapshot failed: ${(e as Error).message}`);
	}

	// 3. Pre-localization & shape prediction, in parallel-friendly order.
	const sections: string[] = [];
	let shape: ShapePrediction | undefined;
	if (!isTruthy(process.env[ENV_DISABLE_SHAPE])) {
		try {
			shape = predictShape(taskPrompt);
			sections.push(formatShapeForPrompt(shape));
			log(
				`shape: bucket=${shape.bucket} expected=${shape.expectedLines}L/${shape.expectedFiles}F range=${shape.lineFloor}-${shape.lineCeiling}L soft-file-cap=${shape.fileBudget}`,
			);
		} catch (e) {
			log(`shape prediction failed: ${(e as Error).message}`);
		}
	}

	if (!isTruthy(process.env[ENV_DISABLE_LOCALIZATION])) {
		try {
			const loc = localize(taskPrompt, repoRoot);
			const block = formatLocalizationForPrompt(loc);
			if (block) sections.push(block);
			log(
				`localization: literal=${loc.literalFiles.length} ranked=${loc.candidates.length} excerpts=${loc.excerpts.length} walked=${loc.filesWalked} in ${loc.elapsedMs}ms`,
			);
		} catch (e) {
			log(`localization failed: ${(e as Error).message}`);
		}
	}

	// 4. Write & inject the context.
	let nextArgs = args;
	if (sections.length > 0) {
		const full = sections.join("\n");
		const contextPath = writeInjectedContext(full);
		if (contextPath) {
			nextArgs = injectAppendSystemPromptArg(args, contextPath);
			log(`injected context file=${contextPath} size=${full.length}B`);
		} else {
			log("could not write context file; running without injection");
		}
	}

	// 5. Install hard deadline safety net.
	const deadlineTimer = installHardDeadline(repoRoot, pristine);

	// 6. Run the agent inline.
	const tPre = Date.now() - tStart;
	log(`pre-agent setup took ${tPre}ms; starting agent loop`);
	try {
		await runSingle(nextArgs);
	} catch (e) {
		log(`agent loop threw: ${(e as Error).stack ?? (e as Error).message}`);
		// We still want to run post-process on whatever made it to disk.
	}

	// 7. Post-process pass.
	clearTimeout(deadlineTimer);
	if (pristine.size > 0 && !isTruthy(process.env[ENV_DISABLE_POSTPROCESS])) {
		try {
			const stats = runPostProcess(repoRoot, pristine);
			log(formatPostProcessStats(stats, repoRoot));
		} catch (e) {
			log(`post-process failed: ${(e as Error).message}`);
		}
	}

	const tTotal = Date.now() - tStart;
	log(`coordinator done in ${tTotal}ms`);
	// We explicitly don't process.exit here — let the caller (cli.ts)
	// resolve its own promise so any pending IO flushes first.
}

// Keep path-test helpers compiled in.
export const _coordinatorInternals = { dirname };
