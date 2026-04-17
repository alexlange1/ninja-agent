/**
 * Shape predictor for SN66 reference diffs.
 *
 * Why this exists
 * ---------------
 * SN66 round-win metric (validator, `tau/src/scoring.py`):
 *
 *     matched_lines = positional longest-matching-blocks between our
 *                     changed-line sequence and the reference's
 *     scored_positions = reference_changed_lines
 *     round_ratio  = matched_lines / scored_positions
 *     round_winner = whichever side has the higher matched_lines count
 *
 * Both AGENTS.md files (ours and v142's) quote the score as
 * `matched / max(your_lines, reference_lines)`, which is a paranoid
 * upper-bound framing — the validator's actual denominator is the
 * reference's changed-line count, so surplus is strictly weakly bad
 * (it doesn't inflate the denominator, it just wastes wall-clock that
 * could otherwise be spent matching more reference lines). The
 * round-decisive quantity is match COUNT, not a ratio — shipping fewer
 * lines than the reference leaves score on the table.
 *
 * A critical hard constraint from `tau/src/tasks/generate.py` filters
 * every generated task:
 *
 *     if reference_changed_lines < 100: discard
 *
 * So EVERY task that reaches a live duel has a reference diff of at
 * least 100 lines. Typical references in our local bench (see
 * `bench/results.json`) ranged from 105 up to 845 changed lines. The
 * previous version of this predictor estimated "~6 lines for micro
 * tasks" and hard-capped the agent at 14 lines of output — which meant
 * Flash was leaving 85-90% of matchable reference positions on the
 * table by design. This file's job is to correct that.
 *
 * This module inspects the plain-English task text and predicts:
 *   - roughly how many files the reference will touch
 *   - a reasonable LOWER bound and UPPER bound for reference size
 *   - an overall size bucket (small / medium / large / huge) — all
 *     buckets respect the ≥100 enforced floor.
 *
 * The prediction is used one way:
 *   - Injected into the system prompt as a *target range* (NOT a hard
 *     cap) so Flash aims to match substantial reference coverage while
 *     still avoiding gratuitous surplus on files the task didn't name.
 *
 * Design principle: the predictor's job is to keep Flash from
 * under-editing. Over-editing is a secondary concern (copy-detection
 * DQ aside, it just wastes compute). So the predicted range leans
 * high, and the prompt framing encourages matching reference-sized
 * coverage on the named files rather than minimalism on principle.
 */

export type ShapeBucket = "small" | "medium" | "large" | "huge";

/** Hard floor enforced by tau task generator: references <100 lines are discarded. */
export const REFERENCE_MIN_LINES = 100;

export interface ShapePrediction {
	/** Rough estimate of number of files the reference diff will touch. */
	expectedFiles: number;
	/** Point estimate of total changed lines in the reference diff. */
	expectedLines: number;
	/** Lower bound on expected reference size — always ≥ REFERENCE_MIN_LINES. */
	lineFloor: number;
	/** Upper bound on expected reference size (use for "aim for" guidance). */
	lineCeiling: number;
	/** Soft cap on files to consider primary targets. */
	fileBudget: number;
	bucket: ShapeBucket;
	/** Human-readable reasoning shown to the LLM. */
	rationale: string;
}

function countAcceptanceCriteria(taskText: string): number {
	// Prefer an explicit "Acceptance criteria" / "Requirements" / "Tasks"
	// section followed by bullets.
	const labelRe =
		/(?:acceptance\s+criteria|requirements|tasks?|todo|steps?):?\s*\n([\s\S]*?)(?:\n\n|\n(?=[A-Z])|\n(?=##)|$)/i;
	const section = taskText.match(labelRe);
	if (section) {
		const bullets = section[1].match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm);
		if (bullets) return bullets.length;
	}
	// Fallback: all bullet points in the whole text.
	const allBullets = taskText.match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm);
	return allBullets ? Math.min(allBullets.length, 12) : 0;
}

function countNamedFiles(taskText: string): number {
	const matches = taskText.match(/`([^`\n]+\.[a-zA-Z0-9]{1,6})`/g) || [];
	const set = new Set<string>();
	for (const m of matches) {
		const inner = m.replace(/`/g, "").trim();
		if (inner.length >= 3 && inner.length <= 120) set.add(inner);
	}
	return set.size;
}

function hasKeyword(text: string, keywords: string[]): boolean {
	const lower = text.toLowerCase();
	return keywords.some((kw) => lower.includes(kw));
}

/**
 * Predict the reference diff shape from task text alone.
 *
 * Calibration comes from two inputs:
 *   - tau's task generator filter: reference is ≥100 changed lines.
 *   - `bench/results.json` local observations: reference sizes in live
 *     tau tasks ranged from 105 to 845 changed lines, with a median
 *     around 300-500 when multi-criterion, and closer to 150-250 for
 *     fix-a-bug single-criterion tasks.
 *
 * The prediction attaches to a TARGET RANGE, not an upper cap. The
 * agent should try to cover as much of the reference as it realistically
 * can on the named files, because round-win is decided by match count.
 *
 * Heuristics (in order of evidence weight):
 *   1. "add / implement / create / introduce" + no named file → bigger
 *      new-surface task, likely multi-file.
 *   2. "fix / rename / replace / update" on a named symbol → narrower
 *      task but STILL ≥100 reference lines by construction.
 *   3. Acceptance-criteria count correlates with reference size.
 *   4. Named-files count is a soft lower bound on expected files touched.
 *   5. "refactor / migrate / across the codebase" wording → shift to
 *      huge bucket.
 */
export function predictShape(taskText: string): ShapePrediction {
	const criteria = countAcceptanceCriteria(taskText);
	const namedFiles = countNamedFiles(taskText);
	const lowered = taskText.toLowerCase();

	const narrowSignals = hasKeyword(lowered, [
		"one line",
		"one-line",
		"single line",
		"typo",
		"off-by-one",
		"off by one",
		"rename ",
		"change the value",
		"update the constant",
		"flip the",
		"swap the",
	]);
	const surgicalSignals = hasKeyword(lowered, [
		"fix ",
		"bug",
		"regression",
		"patch ",
		"correct ",
		"incorrect",
		"edge case",
		"edge-case",
	]);
	const broadSignals = hasKeyword(lowered, [
		"refactor",
		"redesign",
		"restructure",
		"rewrite",
		"across the codebase",
		"every file",
		"all files",
		"migrate",
		"migration",
		"overhaul",
	]);
	const featureSignals = hasKeyword(lowered, [
		"add ",
		"implement",
		"introduce ",
		"create ",
		"new feature",
		"support ",
		"extend ",
		"enhance ",
	]);

	// Floor: the tau task generator guarantees references are ≥100 lines.
	// Ceiling: observed max in bench ≈ 850 lines (likely higher in wild).
	let expectedLines = 160;
	let expectedFiles = Math.max(1, namedFiles);

	// Each acceptance criterion tends to add ~25-40 reference lines.
	if (criteria > 0) {
		expectedLines = Math.max(expectedLines, 120 + criteria * 30);
		if (criteria >= 3) {
			expectedFiles = Math.max(expectedFiles, Math.min(Math.ceil(criteria / 2) + 1, 10));
		}
	}

	if (featureSignals) {
		expectedLines = Math.max(expectedLines, 220);
		expectedFiles = Math.max(expectedFiles, 2);
	}
	if (broadSignals) {
		expectedLines = Math.max(expectedLines, 400);
		expectedFiles = Math.max(expectedFiles, 4);
	}
	if (surgicalSignals && !broadSignals && !featureSignals) {
		// Bug-fix tasks tend to be the smallest references we'll see.
		expectedLines = Math.min(expectedLines, 180);
	}
	if (narrowSignals && !broadSignals && !featureSignals) {
		expectedLines = Math.min(expectedLines, 140);
		expectedFiles = Math.min(expectedFiles, Math.max(1, namedFiles || 1));
	}

	// Never predict below the validator-enforced floor.
	expectedLines = Math.max(expectedLines, REFERENCE_MIN_LINES);

	// Floor / ceiling range shown to the LLM. The floor is the validator
	// guarantee; the ceiling is generous so we don't discourage matching
	// a larger-than-expected reference.
	const lineFloor = REFERENCE_MIN_LINES;
	const lineCeiling = Math.max(expectedLines + 80, Math.ceil(expectedLines * 1.6));

	// File budget stays a soft suggestion, not a hard cap.
	const fileBudget = Math.max(expectedFiles + 1, Math.ceil(expectedFiles * 1.5));

	// Bucket by expected size. All buckets respect the ≥100 floor.
	let bucket: ShapeBucket;
	if (expectedLines <= 180 && expectedFiles <= 2) {
		bucket = "small";
	} else if (expectedLines <= 320 && expectedFiles <= 5) {
		bucket = "medium";
	} else if (expectedLines <= 600 && expectedFiles <= 8) {
		bucket = "large";
	} else {
		bucket = "huge";
	}

	const rationale = buildRationale({
		criteria,
		namedFiles,
		narrowSignals,
		surgicalSignals,
		broadSignals,
		featureSignals,
		bucket,
		expectedFiles,
		expectedLines,
	});

	return {
		expectedFiles,
		expectedLines,
		lineFloor,
		lineCeiling,
		fileBudget,
		bucket,
		rationale,
	};
}

function buildRationale(inputs: {
	criteria: number;
	namedFiles: number;
	narrowSignals: boolean;
	surgicalSignals: boolean;
	broadSignals: boolean;
	featureSignals: boolean;
	bucket: ShapeBucket;
	expectedFiles: number;
	expectedLines: number;
}): string {
	const parts: string[] = [];
	parts.push(`bucket=${inputs.bucket}`);
	parts.push(`~${inputs.expectedLines} ref-lines across ~${inputs.expectedFiles} file(s)`);
	const signalList: string[] = [];
	if (inputs.narrowSignals) signalList.push("narrow-wording");
	if (inputs.surgicalSignals) signalList.push("surgical-wording");
	if (inputs.broadSignals) signalList.push("broad-wording");
	if (inputs.featureSignals) signalList.push("feature-wording");
	if (inputs.criteria > 0) signalList.push(`criteria=${inputs.criteria}`);
	if (inputs.namedFiles > 0) signalList.push(`named-files=${inputs.namedFiles}`);
	if (signalList.length > 0) parts.push(`signals: ${signalList.join(", ")}`);
	return parts.join(" | ");
}

/** Format the prediction for injection into the system prompt. */
export function formatShapeForPrompt(pred: ShapePrediction): string {
	const lines: string[] = [];
	lines.push("# Expected Patch Shape");
	lines.push("");
	lines.push(
		"A deterministic estimator has analyzed the task text. The SN66 task generator filters out any task whose reference diff has fewer than 100 changed lines, so the hidden reference for THIS task is guaranteed to be at least 100 lines — and is usually much larger. Round wins go to whichever side matches MORE reference lines, so under-editing a large reference silently loses score.",
	);
	lines.push("");
	lines.push(`- Bucket: **${pred.bucket}**`);
	lines.push(
		`- Estimated reference size: ~${pred.expectedLines} changed lines across ~${pred.expectedFiles} file(s).`,
	);
	lines.push(
		`- Plausible reference-size range: ${pred.lineFloor}–${pred.lineCeiling} changed lines.`,
	);
	lines.push("");
	lines.push("Rules that follow from this:");
	lines.push(
		`1. Reference diffs for SN66 tasks of this shape typically change ~${pred.expectedLines} lines. Aim to match reference positions across that much content on the task's named files — do not stop after a handful of lines on one file when other named files remain untouched.`,
	);
	lines.push(
		`2. Touch each of the ~${pred.expectedFiles} files the task implies (soft target ≤ ${pred.fileBudget} primary files). Breadth across the right files beats depth on one file.`,
	);
	lines.push(
		"3. Match the reference's edit style on the files it touches. The reference diff makes semantic changes — added logic, new branches, new fields, migrated calls. Your edits on the same files should make the equivalent semantic changes, byte-for-byte in the codebase's style.",
	);
	lines.push(
		"4. DO NOT inflate your diff on unrelated files. Surplus on files outside the reference contributes zero match credit while still burning wall-clock. The reference does not reformat, reindent, or rename unchanged identifiers — neither should you.",
	);
	lines.push(
		"5. Under-editing is the more common failure mode than over-editing. If your plan changes only a handful of lines across 1 file for a multi-criterion task, you are leaving score on the table — expand coverage to every criterion-mapped file before stopping.",
	);
	lines.push("");
	lines.push(`_(shape predictor: ${pred.rationale})_`);
	lines.push("");
	return lines.join("\n");
}
