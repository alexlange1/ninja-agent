/**
 * Parent-side deterministic pre-localization for SN66 duels.
 *
 * Why this exists
 * ---------------
 * Gemini 2.5 Flash inside the validator's sandbox spends 40-90 s on average
 * running `find` / `grep` / `read` calls just to locate the files the task
 * refers to. That's wasted wall-clock: the parent Node process already has
 * full read access to the repo and to the task text BEFORE the LLM is
 * called. We pre-compute a ranked shortlist plus small content excerpts and
 * inject them into the system prompt, so Flash's first tool call can be an
 * `edit` (or at worst a `read` on one of the files we named) instead of
 * starting from zero.
 *
 * What this produces
 * ------------------
 * A markdown block that is appended to the system prompt. It contains:
 *   - Literal files named in the task (absolute matches).
 *   - Ranked candidate files (by keyword-overlap score).
 *   - Small head-of-file excerpts for the top 1-3 candidates (truncated so
 *     the whole block fits inside a Flash context comfortably).
 *   - Per-file style fingerprints (indent, quote, semicolons, trailing
 *     commas) so the LLM's `newText` matches byte-for-byte.
 *
 * The LLM is still responsible for choosing which files to edit and how,
 * but it no longer has to *discover* them. That's a deterministic,
 * free-of-charge step.
 *
 * All code in this module runs in the parent Node process, inside the
 * validator's docker sandbox, before the agent CLI is invoked. It is
 * failure-tolerant: any exception during scanning is swallowed and we fall
 * back to producing an empty block (the LLM still has its normal tools).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

/** Files/dirs we never want to scan or recommend. */
const IGNORED_DIR_NAMES = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	".next",
	"dist",
	"build",
	"out",
	".cache",
	"target",
	".venv",
	"venv",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	"coverage",
	".turbo",
]);

/**
 * Deny-list of extensions we never want to open during scan.
 *
 * Rationale: SN66 tasks can target *any* language — Swift, PHP, Objective-C,
 * Groovy, Kotlin, Zig, etc. A hard-coded allow-list guarantees we'll miss
 * whole task categories (we saw this live: v8sane-001 was PHP, v8sane-002
 * was Swift, and the old allow-list walked 0 files in both).
 *
 * Instead we open anything that isn't obviously binary or build output.
 * Size-gated at MAX_FILE_BYTES_FOR_SCAN and count-gated at MAX_FILES_WALKED.
 */
const BINARY_EXTENSIONS = new Set([
	// Images
	".png",
	".jpg",
	".jpeg",
	".gif",
	".bmp",
	".tiff",
	".tif",
	".ico",
	".webp",
	".heic",
	".heif",
	".avif",
	".psd",
	// Audio / video
	".mp3",
	".mp4",
	".m4a",
	".m4v",
	".wav",
	".flac",
	".ogg",
	".webm",
	".avi",
	".mov",
	".mkv",
	".wmv",
	// Archives
	".zip",
	".tar",
	".gz",
	".tgz",
	".bz2",
	".xz",
	".7z",
	".rar",
	".jar",
	".war",
	".ear",
	".apk",
	".aab",
	".ipa",
	".dmg",
	".iso",
	// Compiled artifacts
	".so",
	".dll",
	".dylib",
	".exe",
	".bin",
	".a",
	".lib",
	".o",
	".obj",
	".class",
	".pyc",
	".pyo",
	".wasm",
	// Fonts
	".woff",
	".woff2",
	".ttf",
	".otf",
	".eot",
	// Documents / proprietary
	".pdf",
	".doc",
	".docx",
	".xls",
	".xlsx",
	".ppt",
	".pptx",
	".key",
	".numbers",
	".pages",
	".sketch",
	".fig",
	".xd",
	// Misc
	".ds_store",
	".db",
	".sqlite",
	".sqlite3",
	".lock",
	".log",
	".min.js",
	".min.css",
	".map",
]);

/** Stop-words for keyword extraction. Case-insensitive match. */
const STOP_WORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
	"from",
	"should",
	"must",
	"when",
	"each",
	"into",
	"also",
	"have",
	"been",
	"will",
	"they",
	"them",
	"their",
	"there",
	"which",
	"what",
	"where",
	"while",
	"would",
	"could",
	"these",
	"those",
	"then",
	"than",
	"some",
	"more",
	"other",
	"only",
	"just",
	"like",
	"such",
	"make",
	"made",
	"does",
	"doing",
	"being",
	"your",
	"you",
	"are",
	"not",
	"but",
	"any",
	"all",
	"can",
	"may",
	"use",
	"used",
	"using",
	"add",
	"new",
	"set",
	"get",
	"one",
	"two",
	"pytest",
	"tests",
	"test",
	"file",
	"files",
	"function",
	"functions",
	"class",
	"classes",
	"method",
	"methods",
	"import",
	"imports",
	"acceptance",
	"criteria",
	"requirements",
	"task",
	"tasks",
	"todo",
]);

/** How many files to emit in the final ranked list. */
const MAX_RANKED_FILES = 10;
/** How many files to include head excerpts for. */
const MAX_EXCERPTS = 3;
/** Max bytes of each excerpt. Small enough to stay within Flash context. */
const EXCERPT_BYTES = 1600;
/** Max bytes of a file we're willing to open for scoring. Skip binaries etc. */
const MAX_FILE_BYTES_FOR_SCAN = 400_000;
/** Hard cap on files walked to avoid runaway scans on giant repos. */
const MAX_FILES_WALKED = 20_000;
/** Max wall-clock budget for the full localization pass. */
const LOCALIZATION_BUDGET_MS = 2_500;

export interface FileCandidate {
	/** Path relative to the repo root, forward-slash separated. */
	relPath: string;
	/** Which keywords matched this file. */
	keywords: Set<string>;
	/** Composite score: weighted by keyword rarity and match count. */
	score: number;
}

export interface LocalizationResult {
	/** Files literally named in the task that exist on disk. */
	literalFiles: string[];
	/** Ranked candidate files. Most relevant first. */
	candidates: FileCandidate[];
	/** Head excerpts for the top few files. */
	excerpts: Array<{ relPath: string; excerpt: string; style: string }>;
	/** Number of files walked before we hit the budget/cap. */
	filesWalked: number;
	/** Approximate milliseconds spent. */
	elapsedMs: number;
}

/**
 * Extract likely-significant tokens from the task text.
 * We prefer identifier-shaped tokens (CamelCase, snake_case, kebab-case,
 * SCREAMING_SNAKE) because those are high signal; plain English words are
 * noisy. Backticked spans win regardless because the task author
 * explicitly highlighted them.
 */
export function extractTaskKeywords(taskText: string): {
	keywords: string[];
	literalPaths: string[];
} {
	const keywords = new Set<string>();
	const literalPathsSet = new Set<string>();
	const text = taskText;

	// 1. Backticked spans — strongest signal.
	const backticked = text.match(/`([^`\n]{1,200})`/g) || [];
	for (const b of backticked) {
		const inner = b.slice(1, -1).trim();
		if (!inner) continue;
		// A path-shaped token inside backticks gets promoted to literal.
		if (/^[\w./-]+\.[a-zA-Z0-9]{1,8}$/.test(inner)) {
			literalPathsSet.add(inner.replace(/^\.\//, ""));
		}
		// The backticked content itself is also a keyword. Cap length to
		// stop full code blocks from turning into one giant keyword.
		if (inner.length >= 2 && inner.length <= 100) {
			keywords.add(inner);
		}
	}

	// 2. Identifier-shaped tokens outside backticks.
	for (const pattern of [
		/\b[A-Z][a-z0-9]+(?:[A-Z][a-zA-Z0-9]*)+\b/g, // CamelCase
		/\b[a-z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]+)+\b/g, // camelCase
		/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, // snake_case
		/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, // SCREAMING_SNAKE
		/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g, // kebab-case
	]) {
		const matches = text.match(pattern) || [];
		for (const m of matches) {
			if (m.length >= 3 && m.length <= 80 && !STOP_WORDS.has(m.toLowerCase())) {
				keywords.add(m);
			}
		}
	}

	// 3. Explicit path-like tokens outside backticks.
	const pathRe = /(?:^|[\s"'`([])((?:\.\.?\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,8})(?=$|[\s"'`)\],:;.!?])/g;
	for (;;) {
		const pm = pathRe.exec(text);
		if (pm === null) break;
		const cleaned = pm[1].trim().replace(/^\.\//, "");
		literalPathsSet.add(cleaned);
		keywords.add(cleaned);
	}

	// 4. Bare filenames (no directory) but with a dotted extension.
	const bareRe = /\b([A-Za-z_][\w.-]*\.[a-zA-Z]{1,8})\b/g;
	for (;;) {
		const bm = bareRe.exec(text);
		if (bm === null) break;
		const f = bm[1];
		if (f.length >= 3 && f.length <= 80) {
			keywords.add(f);
		}
	}

	// De-duplicate literal paths that survived as full paths.
	const literalPaths = [...literalPathsSet];
	const keywordList = [...keywords].filter((k) => !/^["']/.test(k)).slice(0, 48); // hard cap to bound scan cost
	return { keywords: keywordList, literalPaths };
}

/** Walk repo files (bounded), returning posix paths relative to root. */
function walkRepo(root: string, deadline: number): { files: string[]; hitLimit: boolean } {
	const files: string[] = [];
	const stack: string[] = [root];
	let hitLimit = false;
	while (stack.length > 0) {
		if (Date.now() > deadline || files.length >= MAX_FILES_WALKED) {
			hitLimit = true;
			break;
		}
		const dir = stack.pop()!;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (IGNORED_DIR_NAMES.has(name)) continue;
			if (name.startsWith(".") && name !== "." && name !== "..") {
				// Skip dot-files at scan time but not dot-dirs named above.
				// Still walk into `.github` etc. below if needed? For SN66
				// tasks, these rarely matter. Skip.
				continue;
			}
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
				if (st.size > MAX_FILE_BYTES_FOR_SCAN) continue;
				const lowered = name.toLowerCase();
				const ext = extname(lowered);
				// Skip obviously binary artifacts. Extension-less files
				// (Dockerfile, Makefile, .gitignore, etc.) pass through.
				if (ext && BINARY_EXTENSIONS.has(ext)) continue;
				// Catch common double-extensions we explicitly deny.
				if (lowered.endsWith(".min.js") || lowered.endsWith(".min.css") || lowered.endsWith(".map")) {
					continue;
				}
				files.push(full);
			}
		}
	}
	return { files, hitLimit };
}

/**
 * Quick & dirty keyword-rarity score: rare keywords (fewer file hits) are
 * worth more than common ones. We favor files that match multiple
 * keywords over files that match one keyword many times.
 */
function scoreCandidates(
	root: string,
	files: string[],
	keywords: string[],
	deadline: number,
): Map<string, FileCandidate> {
	const candidates = new Map<string, FileCandidate>();
	if (keywords.length === 0) return candidates;

	// First pass: global hit counts per keyword so rarer keywords weigh more.
	const keywordHits = new Map<string, number>();
	// Second pass: per-file keyword membership.
	const perFileMatches = new Map<string, Set<string>>();
	// Pre-build literal byte-safe needles.
	const needles = keywords.map((k) => ({ keyword: k, lower: k.toLowerCase() }));

	for (const abs of files) {
		if (Date.now() > deadline) break;
		let content: string;
		try {
			const buf = readFileSync(abs);
			content = buf.toString("utf-8");
		} catch {
			continue;
		}
		const lower = content.toLowerCase();
		// Also the basename is a strong signal.
		const base = basename(abs).toLowerCase();
		const fileRel = relative(root, abs).split(/\\/).join("/");
		const matched = new Set<string>();
		for (const n of needles) {
			if (lower.includes(n.lower) || base.includes(n.lower)) {
				matched.add(n.keyword);
				keywordHits.set(n.keyword, (keywordHits.get(n.keyword) ?? 0) + 1);
			}
		}
		if (matched.size > 0) {
			perFileMatches.set(fileRel, matched);
		}
	}

	// Convert hit counts to inverse-frequency weights. Keyword hit in 1
	// file → weight 1; hit in N files → weight 1/log2(N+1).
	for (const [relPath, matched] of perFileMatches) {
		let score = 0;
		for (const kw of matched) {
			const hits = keywordHits.get(kw) ?? 1;
			const rarity = 1 / Math.log2(hits + 2);
			// Bonus: the keyword appears in the file's basename.
			const base = basename(relPath).toLowerCase();
			const baseBonus = base.includes(kw.toLowerCase()) ? 0.5 : 0;
			score += rarity + baseBonus;
		}
		// Penalize very large files slightly — the reference diff tends to
		// land in focused, small-to-medium files.
		let sizeBytes = 0;
		try {
			sizeBytes = statSync(join(root, relPath)).size;
		} catch {}
		if (sizeBytes > 60_000) score *= 0.85;
		if (sizeBytes > 200_000) score *= 0.8;

		candidates.set(relPath, {
			relPath,
			keywords: matched,
			score,
		});
	}

	return candidates;
}

/** Detect file style (indent, quotes, semicolons, trailing commas). */
function detectFileStyle(absPath: string): string {
	try {
		const content = readFileSync(absPath, "utf-8");
		const head = content.slice(0, 32_000);
		const lines = head.split("\n").slice(0, 80);
		if (lines.length === 0) return "unknown";
		let usesTabs = 0;
		let usesSpaces = 0;
		const spaceWidths = new Map<number, number>();
		for (const line of lines) {
			if (/^\t/.test(line)) {
				usesTabs++;
			} else {
				const m = line.match(/^( +)/);
				if (m) {
					usesSpaces++;
					const w = m[1].length;
					if (w === 2 || w === 4 || w === 8) {
						spaceWidths.set(w, (spaceWidths.get(w) ?? 0) + 1);
					}
				}
			}
		}
		let indent = "mixed";
		if (usesTabs > usesSpaces) {
			indent = "tabs";
		} else if (usesSpaces > 0) {
			let bestW = 2;
			let bestC = 0;
			for (const [w, c] of spaceWidths) {
				if (c > bestC) {
					bestC = c;
					bestW = w;
				}
			}
			indent = `${bestW}-space`;
		}
		const single = (head.match(/'/g) || []).length;
		const double = (head.match(/"/g) || []).length;
		const quotes = single > double * 1.5 ? "single" : double > single * 1.5 ? "double" : "mixed";
		let codeLines = 0;
		let semiLines = 0;
		for (const line of lines) {
			const t = line.trim();
			if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("*")) continue;
			codeLines++;
			if (t.endsWith(";")) semiLines++;
		}
		const semis = codeLines === 0 ? "n/a" : semiLines / codeLines > 0.3 ? "yes" : "no";
		const trailingCommas = /,\s*[\n\r]\s*[)\]}]/.test(head) ? "yes" : "no";
		const finalNewline = content.endsWith("\n") ? "yes" : "no";
		return `indent=${indent}, quotes=${quotes}, semicolons=${semis}, trailing-commas=${trailingCommas}, final-newline=${finalNewline}`;
	} catch {
		return "unknown";
	}
}

/** Grab the head of a file, truncated on a line boundary to EXCERPT_BYTES. */
function readExcerpt(absPath: string): string {
	try {
		const raw = readFileSync(absPath, "utf-8");
		if (raw.length <= EXCERPT_BYTES) return raw;
		const sliced = raw.slice(0, EXCERPT_BYTES);
		const lastNewline = sliced.lastIndexOf("\n");
		const safe = lastNewline > 0 ? sliced.slice(0, lastNewline) : sliced;
		return `${safe}\n… [truncated — ${raw.length - safe.length} more bytes]`;
	} catch {
		return "";
	}
}

/** Run the full localization pass. Bounded by LOCALIZATION_BUDGET_MS. */
export function localize(taskText: string, repoRoot: string): LocalizationResult {
	const started = Date.now();
	const deadline = started + LOCALIZATION_BUDGET_MS;
	const { keywords, literalPaths } = extractTaskKeywords(taskText);

	// Resolve literal paths on disk (repo-root-relative or relative).
	const literalFiles: string[] = [];
	for (const p of literalPaths) {
		try {
			const abs = join(repoRoot, p);
			const st = statSync(abs);
			if (st.isFile()) literalFiles.push(p);
		} catch {
			// Ignore — literal path may not exist in this repo.
		}
	}

	let files: string[] = [];
	if (keywords.length > 0) {
		const walk = walkRepo(repoRoot, deadline);
		files = walk.files;
	}
	const candidateMap = scoreCandidates(repoRoot, files, keywords, deadline);

	// Boost literal-file matches to the top (even if they didn't score via
	// keywords, they're still prioritized).
	for (const lit of literalFiles) {
		const existing = candidateMap.get(lit);
		if (existing) {
			existing.score += 10;
		} else {
			candidateMap.set(lit, {
				relPath: lit,
				keywords: new Set<string>(["<literal-task-path>"]),
				score: 10,
			});
		}
	}

	const candidates = [...candidateMap.values()].sort((a, b) => b.score - a.score).slice(0, MAX_RANKED_FILES);

	// Build excerpts for the top MAX_EXCERPTS candidates (literal files
	// first), but only if we still have time.
	const excerptTargets: string[] = [];
	for (const lit of literalFiles) {
		if (!excerptTargets.includes(lit)) excerptTargets.push(lit);
		if (excerptTargets.length >= MAX_EXCERPTS) break;
	}
	for (const c of candidates) {
		if (excerptTargets.length >= MAX_EXCERPTS) break;
		if (!excerptTargets.includes(c.relPath)) excerptTargets.push(c.relPath);
	}

	const excerpts: LocalizationResult["excerpts"] = [];
	for (const relPath of excerptTargets) {
		if (Date.now() > deadline) break;
		const abs = join(repoRoot, relPath);
		const excerpt = readExcerpt(abs);
		const style = detectFileStyle(abs);
		if (excerpt) excerpts.push({ relPath, excerpt, style });
	}

	return {
		literalFiles,
		candidates,
		excerpts,
		filesWalked: files.length,
		elapsedMs: Date.now() - started,
	};
}

/**
 * Format a LocalizationResult into the markdown block that gets appended
 * to the system prompt. Returns an empty string if nothing useful was
 * found — in that case we don't waste context-window budget on empty
 * scaffolding.
 */
export function formatLocalizationForPrompt(result: LocalizationResult): string {
	if (result.literalFiles.length === 0 && result.candidates.length === 0 && result.excerpts.length === 0) {
		return "";
	}

	const lines: string[] = [];
	lines.push("# Pre-localized Task Context");
	lines.push("");
	lines.push(
		"A parent scan of the repository has already run. The results below are deterministic (no LLM involved). Trust them: start from the named files instead of rediscovering via `grep`/`find`.",
	);
	lines.push("");

	if (result.literalFiles.length > 0) {
		lines.push("## Files explicitly named in the task (start here)");
		for (const f of result.literalFiles) {
			lines.push(`- \`${f}\``);
		}
		lines.push("");
	}

	const rankedOnly = result.candidates.filter((c) => !result.literalFiles.includes(c.relPath));
	if (rankedOnly.length > 0) {
		lines.push("## Likely-relevant files (ranked by keyword overlap)");
		for (const c of rankedOnly) {
			const kws = [...c.keywords]
				.filter((k) => k !== "<literal-task-path>")
				.slice(0, 5)
				.map((k) => `\`${k}\``)
				.join(", ");
			lines.push(`- \`${c.relPath}\` — matches: ${kws}`);
		}
		lines.push("");
	}

	if (result.excerpts.length > 0) {
		lines.push("## Pre-read excerpts (top candidates)");
		lines.push("");
		lines.push(
			"Each excerpt is the head of the file as it exists on disk right now. Use these to pick anchors for `edit` directly — you usually will not need a separate `read` call for these files.",
		);
		lines.push("");
		for (const ex of result.excerpts) {
			lines.push(`### \`${ex.relPath}\``);
			lines.push(`Style: ${ex.style}`);
			lines.push("");
			lines.push("```");
			lines.push(ex.excerpt);
			lines.push("```");
			lines.push("");
		}
	}

	lines.push("## How to use this section");
	lines.push("");
	lines.push(
		"1. If the task names files literally, edit those first. Every literal file should receive at least one edit.",
	);
	lines.push(
		"2. Otherwise, edit the top ranked candidate. Only fall back to the next candidate if an edit anchor cannot be constructed from the excerpt.",
	);
	lines.push(
		"3. Never re-`grep`/`find` for something that is already listed above. That wastes the 300 s budget and never changes the answer.",
	);
	lines.push(
		"4. If the excerpt is enough to build a precise `oldText`, skip `read` entirely and go straight to `edit`.",
	);
	lines.push("");
	lines.push(`_(localization scan: ${result.filesWalked} files walked in ${result.elapsedMs} ms)_`);
	lines.push("");

	return lines.join("\n");
}
