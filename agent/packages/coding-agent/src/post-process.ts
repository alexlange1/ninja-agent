/**
 * Deterministic post-processing pass for SN66 duels.
 *
 * Why this exists
 * ---------------
 * Gemini Flash routinely produces edits that are semantically correct but
 * byte-misaligned with the reference diff: it adds a trailing blank line
 * where the reference didn't, strips trailing whitespace from lines it
 * didn't intend to change, flips quote styles, or reindents a sibling
 * block for "consistency". All of those count as surplus under SN66's
 * positional line match.
 *
 * This pass runs in the parent Node process AFTER the agent has finished
 * writing to /work/repo. It walks every file the agent modified, diffs
 * it against the pristine snapshot, and applies a set of strictly
 * conservative byte-level normalizations:
 *
 *   1. Restore the pristine file's final-newline state. If the pristine
 *      file ended with `\n`, ours will too; if it didn't, we strip ours.
 *   2. Restore trailing-whitespace on lines that match the pristine
 *      content exactly (i.e. lines the agent did not semantically
 *      change). This catches Flash's frequent auto-trim.
 *   3. Restore the pristine line-ending style (CRLF vs LF) globally.
 *   4. Remove a trailing blank line that the agent appended at EOF if
 *      the pristine did not have one.
 *
 * IMPORTANT: this pass NEVER touches a line whose semantic content
 * differs from the pristine. The agent's logical edits are preserved
 * verbatim. We only fix bytes on lines that are otherwise identical.
 *
 * The pass is cheap — a few hundred ms for a typical repo — and is
 * always safe to run. Worst case, it's a no-op.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

export interface PostProcessStats {
	filesExamined: number;
	filesModifiedByPass: number;
	trailingWhitespaceRestorations: number;
	finalNewlineFixes: number;
	trailingBlankLineRemovals: number;
	lineEndingRestorations: number;
	skippedMissing: number;
}

/**
 * Compare pristine bytes to current bytes. If bytes are identical, no-op.
 * Otherwise, apply conservative normalizations and rewrite the file.
 *
 * Returns true if the file was rewritten.
 */
function normalizeOneFile(absPath: string, pristine: Buffer, stats: PostProcessStats): boolean {
	let current: Buffer;
	try {
		current = readFileSync(absPath);
	} catch {
		stats.skippedMissing++;
		return false;
	}
	stats.filesExamined++;
	if (current.equals(pristine)) return false;

	const pristineText = pristine.toString("utf-8");
	let currentText = current.toString("utf-8");

	// (3) Line-ending normalization first — so later line-by-line
	// comparisons work regardless of CRLF/LF mismatches.
	const pristineHasCRLF = /\r\n/.test(pristineText);
	const currentHasCRLF = /\r\n/.test(currentText);
	if (pristineHasCRLF && !currentHasCRLF) {
		// Pristine uses CRLF, current collapsed to LF. Convert back.
		currentText = currentText.replace(/\r?\n/g, "\r\n");
		stats.lineEndingRestorations++;
	} else if (!pristineHasCRLF && currentHasCRLF) {
		// Pristine is LF, current introduced CRLF. Normalize.
		currentText = currentText.replace(/\r\n/g, "\n");
		stats.lineEndingRestorations++;
	}

	// Work on LF-normalized copies for line comparisons.
	const pristineLines = pristineText.replace(/\r\n/g, "\n").split("\n");
	let workingLines = currentText.replace(/\r\n/g, "\n").split("\n");

	// (2) Restore trailing whitespace on structurally unchanged lines.
	// We treat a line as "unchanged" if, after rstrip, it equals its
	// pristine counterpart at the same index.
	const restoredCount = { value: 0 };
	workingLines = restoreTrailingWhitespace(pristineLines, workingLines, restoredCount);
	stats.trailingWhitespaceRestorations += restoredCount.value;

	// (4) If pristine doesn't end with a blank-line run and current does,
	// strip the excess. Specifically: if pristine's last non-empty line
	// index is L and pristine has P blank lines after, current should
	// have at most P blank lines after the corresponding content.
	const rebuilt = trimTrailingBlankLines(pristineLines, workingLines, stats);
	workingLines = rebuilt;

	// Reconstitute with the correct line ending.
	const lineSep = /\r\n/.test(currentText) || pristineHasCRLF ? "\r\n" : "\n";
	let newText = workingLines.join(lineSep);

	// (1) Final newline match. `lines` split drops the implicit final
	// empty element when the original had a trailing newline; we have to
	// reconstruct that explicitly.
	const pristineEndsNL = pristineText.endsWith("\n");
	const currentEndsNL = newText.endsWith("\n");
	if (pristineEndsNL && !currentEndsNL) {
		newText += lineSep;
		stats.finalNewlineFixes++;
	} else if (!pristineEndsNL && currentEndsNL) {
		// Remove the trailing newline.
		newText = newText.replace(/(\r?\n)+$/, "");
		stats.finalNewlineFixes++;
	}

	if (newText === currentText) return false;

	try {
		writeFileSync(absPath, newText);
		stats.filesModifiedByPass++;
		return true;
	} catch {
		return false;
	}
}

/**
 * Walk both line arrays in lock-step. Whenever a current line's
 * rstripped form equals the pristine line at the same index, copy the
 * pristine line's exact trailing whitespace back onto the current one.
 */
function restoreTrailingWhitespace(
	pristineLines: string[],
	currentLines: string[],
	counter: { value: number },
): string[] {
	// If the two arrays have very different lengths we can't safely align
	// by index. Try the simpler approach: only restore where pristine
	// indexes exist AND the rstripped content matches.
	const out: string[] = [];
	for (let i = 0; i < currentLines.length; i++) {
		const cur = currentLines[i];
		const pris = i < pristineLines.length ? pristineLines[i] : undefined;
		if (pris === undefined) {
			out.push(cur);
			continue;
		}
		const curRStripped = cur.replace(/[ \t]+$/, "");
		const prisRStripped = pris.replace(/[ \t]+$/, "");
		if (curRStripped === prisRStripped && cur !== pris) {
			// Same semantic content but current lost trailing whitespace.
			// Restore pristine's trailing whitespace verbatim.
			out.push(pris);
			counter.value++;
		} else {
			out.push(cur);
		}
	}
	return out;
}

/**
 * If the current content has more blank lines at the end of the file
 * than the pristine did, strip the excess blanks.
 */
function trimTrailingBlankLines(pristineLines: string[], currentLines: string[], stats: PostProcessStats): string[] {
	const pristineTrailingBlanks = countTrailingBlankLines(pristineLines);
	const currentTrailingBlanks = countTrailingBlankLines(currentLines);
	if (currentTrailingBlanks <= pristineTrailingBlanks) return currentLines;

	const excess = currentTrailingBlanks - pristineTrailingBlanks;
	// Remove `excess` blank lines from the end. Split() on "\n" always
	// yields one final empty element if the text ended with \n, so we
	// have to be careful not to remove that one here — the final-newline
	// correction above handles that case.
	const rebuilt = currentLines.slice();
	let removed = 0;
	while (removed < excess && rebuilt.length > 0) {
		const tail = rebuilt[rebuilt.length - 1];
		if (tail.trim() === "") {
			rebuilt.pop();
			removed++;
		} else {
			break;
		}
	}
	stats.trailingBlankLineRemovals += removed;
	return rebuilt;
}

function countTrailingBlankLines(lines: string[]): number {
	let count = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim() === "") count++;
		else break;
	}
	return count;
}

/**
 * Run the post-process pass over every file present in the pristine
 * snapshot. Files whose current bytes still match the pristine are
 * skipped. Files the agent deleted (i.e. no longer exist) are skipped
 * (the deletion is a legitimate edit).
 *
 * @param repoRoot absolute repo root (= /work/repo inside the sandbox)
 * @param pristine Map<relPath, Buffer> — snapshot taken before the agent ran
 */
export function runPostProcess(repoRoot: string, pristine: Map<string, Buffer>): PostProcessStats {
	const stats: PostProcessStats = {
		filesExamined: 0,
		filesModifiedByPass: 0,
		trailingWhitespaceRestorations: 0,
		finalNewlineFixes: 0,
		trailingBlankLineRemovals: 0,
		lineEndingRestorations: 0,
		skippedMissing: 0,
	};

	for (const [rel, pristineBuf] of pristine) {
		const abs = `${repoRoot}/${rel}`;
		try {
			normalizeOneFile(abs, pristineBuf, stats);
		} catch {
			// Never let the post-process pass kill the whole run.
		}
	}

	return stats;
}

/**
 * Format the pass's stats for logging. Returns a single line.
 */
export function formatPostProcessStats(stats: PostProcessStats, repoRoot: string): string {
	const tag = relative(process.cwd(), repoRoot) || repoRoot;
	return (
		`[post-process] ${tag}: ` +
		`examined=${stats.filesExamined} ` +
		`rewritten=${stats.filesModifiedByPass} ` +
		`wsrestore=${stats.trailingWhitespaceRestorations} ` +
		`finalnl=${stats.finalNewlineFixes} ` +
		`blanktrim=${stats.trailingBlankLineRemovals} ` +
		`lineend=${stats.lineEndingRestorations} ` +
		`missing=${stats.skippedMissing}`
	);
}
