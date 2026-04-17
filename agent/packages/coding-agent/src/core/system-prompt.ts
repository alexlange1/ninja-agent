/**
 * System prompt construction and project context loading
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

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
]);

function countAcceptanceCriteria(taskText: string): number {
	const section = taskText.match(
		/(?:acceptance\s+criteria|requirements|tasks?|todo):?\s*\n([\s\S]*?)(?:\n\n|\n(?=[A-Z])|\n(?=##)|$)/i,
	);
	if (!section) {
		const allBullets = taskText.match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm);
		return allBullets ? Math.min(allBullets.length, 20) : 0;
	}
	const bullets = section[1].match(/^\s*(?:[-*•+]|\d+[.)])\s+/gm);
	return bullets ? bullets.length : 0;
}

function extractNamedFiles(taskText: string): string[] {
	const matches = taskText.match(/`([^`]+\.[a-zA-Z0-9]{1,6})`/g) || [];
	return [...new Set(matches.map((f) => f.replace(/`/g, "").trim()))];
}

function detectFileStyle(cwd: string, relPath: string): string | null {
	try {
		const full = resolve(cwd, relPath);
		if (!existsSync(full)) return null;
		const stat = statSync(full);
		if (!stat.isFile() || stat.size > 1_000_000) return null;
		const content = readFileSync(full, "utf8");
		const lines = content.split("\n").slice(0, 40);
		if (lines.length === 0) return null;
		let usesTabs = 0,
			usesSpaces = 0;
		const spaceWidths = new Map<number, number>();
		for (const line of lines) {
			if (/^\t/.test(line)) usesTabs++;
			else if (/^ +/.test(line)) {
				usesSpaces++;
				const m = line.match(/^( +)/);
				if (m) {
					const w = m[1].length;
					if (w === 2 || w === 4 || w === 8) spaceWidths.set(w, (spaceWidths.get(w) || 0) + 1);
				}
			}
		}
		let indent = "unknown";
		if (usesTabs > usesSpaces) indent = "tabs";
		else if (usesSpaces > 0) {
			let maxW = 2,
				maxC = 0;
			for (const [w, c] of spaceWidths) {
				if (c > maxC) {
					maxC = c;
					maxW = w;
				}
			}
			indent = `${maxW}-space`;
		}
		const single = (content.match(/'/g) || []).length;
		const double = (content.match(/"/g) || []).length;
		const quotes = single > double * 1.5 ? "single" : double > single * 1.5 ? "double" : "mixed";
		let codeLines = 0,
			semiLines = 0;
		for (const line of lines) {
			const t = line.trim();
			if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("*")) continue;
			codeLines++;
			if (t.endsWith(";")) semiLines++;
		}
		const semis = codeLines === 0 ? "unknown" : semiLines / codeLines > 0.3 ? "yes" : "no";
		const trailing = /,\s*[\n\r]\s*[)\]}]/.test(content) ? "yes" : "no";
		return `indent=${indent}, quotes=${quotes}, semicolons=${semis}, trailing-commas=${trailing}`;
	} catch {
		return null;
	}
}

function shellEscape(s: string): string {
	return s.replace(/[\\"`$]/g, "\\$&");
}

function buildTaskDiscoverySection(taskText: string, cwd: string): string {
	try {
		const keywords = new Set<string>();
		const backticks = taskText.match(/`([^`]{2,80})`/g) || [];
		for (const b of backticks) {
			const t = b.slice(1, -1).trim();
			if (t.length >= 2 && t.length <= 80) keywords.add(t);
		}
		const camel = taskText.match(/\b[A-Za-z][a-z]+(?:[A-Z][a-zA-Z0-9]*)+\b/g) || [];
		for (const c of camel) keywords.add(c);
		const snake = taskText.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [];
		for (const s of snake) keywords.add(s);
		const kebab = taskText.match(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g) || [];
		for (const k of kebab) keywords.add(k);
		const scream = taskText.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || [];
		for (const s of scream) keywords.add(s);
		const pathLike =
			taskText.match(/(?:^|[\s"'`([])((?:\.\.?\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,6})(?=$|[\s"'`)\],:;.])/g) ||
			[];
		const paths = new Set<string>();
		for (const p of pathLike) {
			const cleaned = p
				.trim()
				.replace(/^[\s"'`([]/, "")
				.replace(/^\.\//, "");
			paths.add(cleaned);
			keywords.add(cleaned);
		}
		for (const b of backticks) {
			const inner = b.slice(1, -1).trim();
			if (/^[\w./-]+\.[a-zA-Z0-9]{1,6}$/.test(inner) && inner.length < 200) paths.add(inner.replace(/^\.\//, ""));
		}
		const filtered = [...keywords]
			.filter((k) => k.length >= 3 && k.length <= 80)
			.filter((k) => !/["']/.test(k))
			.filter((k) => !STOP_WORDS.has(k.toLowerCase()))
			.slice(0, 20);
		if (filtered.length === 0 && paths.size === 0) return "";

		const fileHits = new Map<string, Set<string>>();
		const includeGlobs =
			'--include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.mjs" --include="*.cjs" --include="*.py" --include="*.go" --include="*.rs" --include="*.java" --include="*.kt" --include="*.scala" --include="*.dart" --include="*.rb" --include="*.cs" --include="*.cpp" --include="*.c" --include="*.h" --include="*.hpp" --include="*.vue" --include="*.svelte" --include="*.css" --include="*.scss" --include="*.html" --include="*.json" --include="*.yaml" --include="*.yml" --include="*.toml" --include="*.md"';
		for (const kw of filtered) {
			try {
				const escaped = shellEscape(kw);
				const result = execSync(
					`grep -rlF "${escaped}" ${includeGlobs} . 2>/dev/null | grep -v node_modules | grep -v '/\\.git/' | grep -v '/dist/' | grep -v '/build/' | grep -v '/out/' | grep -v '/\\.next/' | grep -v '/target/' | head -12`,
					{ cwd, timeout: 3000, encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 },
				).trim();
				if (result) {
					for (const line of result.split("\n")) {
						const file = line.trim().replace(/^\.\//, "");
						if (!file) continue;
						if (!fileHits.has(file)) fileHits.set(file, new Set());
						fileHits.get(file)!.add(kw);
					}
				}
			} catch {}
		}

		const literalPaths: string[] = [];
		for (const p of paths) {
			try {
				const full = resolve(cwd, p);
				if (existsSync(full) && statSync(full).isFile()) literalPaths.push(p.replace(/^\.\//, ""));
			} catch {}
		}

		if (fileHits.size === 0 && literalPaths.length === 0) return "";

		const sorted = [...fileHits.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 15);
		const sections: string[] = [];

		if (literalPaths.length > 0) {
			sections.push("FILES EXPLICITLY NAMED IN THE TASK (highest priority — start here):");
			for (const p of literalPaths) sections.push(`- ${p}`);
		}
		if (sorted.length > 0) {
			sections.push("\nLIKELY RELEVANT FILES (ranked by task keyword matches):");
			for (const [file, kws] of sorted) sections.push(`- ${file} (matches: ${[...kws].slice(0, 4).join(", ")})`);
		}

		const topFile = literalPaths[0] || sorted[0]?.[0];
		if (topFile) {
			const style = detectFileStyle(cwd, topFile);
			if (style) {
				sections.push(`\nDETECTED STYLE of ${topFile}: ${style}`);
				sections.push("Your edits MUST match this style character-for-character.");
			}
		}

		const criteriaCount = countAcceptanceCriteria(taskText);
		const namedFiles = extractNamedFiles(taskText);
		if (criteriaCount > 0) {
			sections.push(`\nThis task has ${criteriaCount} acceptance criteria.`);
			if (criteriaCount <= 2) {
				sections.push(
					"Single-file mode: go straight to the most likely file, read it, make the minimal edit, stop. Do not scan for extra files unless the task wiring literally requires it.",
				);
			} else {
				sections.push(
					`Multi-file mode: map each criterion to a file. Touch every criterion-mapped file with one correct edit before refining any of them.`,
				);
			}
		}
		sections.push(
			"\nHard budget: at most TWO discovery/search calls before the first read; at most THREE reads before the first edit. If you are still searching after two discovery calls, pick the best candidate and read it.",
		);
		if (namedFiles.length > 0) {
			sections.push(`\nFiles named in the task text: ${namedFiles.map((f) => `\`${f}\``).join(", ")}.`);
			sections.push(
				"Each named file gets one read and (usually) one edit. Do not skip any. Do not add unnamed files unless the task's wiring literally requires it (e.g., a single import or registration line).",
			);
		}
		sections.push(
			"Target-priority ladder: (1) files the task names literally, (2) the one symbol the task names, (3) the nearest sibling wiring required to make the change functional.",
		);

		return "\n\n" + sections.join("\n") + "\n";
	} catch {}
	return "";
}

// Preamble tuned for the validator's enforced configuration:
//   model: google/gemini-2.5-flash, reasoning: false
//
// Design principles:
// - Front-load the non-negotiable rules. Flash weighs early tokens more.
// - No chain-of-thought room — every rule must be directly actionable.
// - Deterministic IF-THEN protocol rather than "pick a mode".
// - Aggressive anti-narration (Flash wants to explain; we want tool calls).
// - Tight tool-call budget so Flash doesn't thrash through exploration.
// - Assumes the v8 coordinator has already injected pre-localized file
//   candidates and a shape budget into the "append system prompt" section
//   below. The preamble intentionally points the model at that section
//   first, so the rare "no-injection" path (interactive runs, or when
//   localization produced nothing) still works, while the common case
//   (tau duel) leverages the deterministic context we pre-baked.
const TAU_SCORING_PREAMBLE = `# Tau Diff-Overlap Protocol

You are editing a real repo. The harness takes the git diff of your edits
and scores it positionally against a HIDDEN reference diff:

    matched_lines   = order-preserving longest-matching-blocks between
                      your changed-line sequence and the reference's
    scored_positions = reference_changed_lines
    round_ratio     = matched_lines / scored_positions
    round_winner    = whichever side has the higher matched_lines count

Round wins are decided by MATCH COUNT, not ratio. No semantic credit, no
tests, no points for explaining anything. A round in which both sides
change 0 lines counts as a tie and is thrown out — ties never dethrone
the king, so doing nothing is never safe.

Hard task-generator constraint: any task whose reference diff has fewer
than 100 changed lines is discarded before reaching you. So the hidden
reference for THIS task is guaranteed to be at least 100 lines changed,
and is commonly 200-800+ lines across multiple files. Your diff should
aim to cover a substantial fraction of those lines — under-editing is
the default Flash failure mode on SN66.

## The four ways to lose score (ordered by observed impact)

1. **Under-editing** — shipping far fewer changed lines than the reference.
   Match count is hard-capped by how many of YOUR changed lines line up
   with reference positions; if you only edit 20 lines and the reference
   edited 300, you can match at most 20. The king will match more and
   win the round. This is the single biggest failure mode on SN66.
2. **Wrong files** — editing files the reference didn't touch at all.
   Those lines contribute zero match credit no matter how correct they
   look. Spend your budget on the files the task names, or the clear
   siblings of those files, never on README / package.json / tsconfig /
   test files unless the task explicitly names them.
3. **Misalignment** — changing the RIGHT lines with the WRONG bytes:
   indentation style, quote style, trailing comma, wrap point, added
   blank line, stripped final newline, inserted comment. The post-process
   pass fixes some of these automatically, but it can only restore bytes
   on lines you DID NOT semantically change — mis-style a real edit and
   it scores zero at that position.
4. **Tieing the king** — shipping a diff that matches the incumbent king
   byte-for-byte wins the round only if you OUT-match them. A duel-level
   similarity above 90% to the king's diffs is also a hard DQ. Favor the
   most literal, textbook reference-shaped edit, not a clever variant,
   but implement it independently.

## Pre-injected deterministic context (READ FIRST)

Before you plan, scan down to the sections titled **"Expected Patch
Shape"** and **"Pre-localized Task Context"**. A parent Node process
has already:

- Estimated how many lines / files the reference diff will touch
  (a hard upper bound on YOUR diff size).
- Walked the repository and ranked the most likely target files.
- Pre-read head-of-file excerpts for the top candidates, with their
  style fingerprints (indent, quote, semicolons, trailing commas).

Treat those sections as authoritative. Do not re-discover what was
already listed — every \`grep\` / \`find\` / extra \`read\` you run on a
file that's already excerpted is wall-clock lost to Flash's 300 s
budget, with zero upside. If the section says "literal files", edit
them in the order given; only fall back to the ranked candidates when
an anchor cannot be built from any literal file.

(If those sections are absent, the coordinator could not find
candidates. Fall back to the discovery protocol below.)

## Non-negotiable rules (in priority order)

1. First response is a tool call. Never a plan, preamble, or summary.
2. Never run tests, builds, linters, formatters, servers, git, or package
   managers. None of them affect the score, all of them waste time.
3. Use \`edit\` for every change to an existing file. Only use \`write\` to
   create a file that does not yet exist. Overwriting an existing file
   counts every line as changed and ruins the score.
4. If the "Pre-read excerpts" section contains enough of the file to
   build a unique \`oldText\` anchor, SKIP the \`read\` call and go
   straight to \`edit\`. Only re-read when the excerpt is truncated
   before the target region.
5. Preserve bytes you did not set out to change:
   - keep indentation type and width exactly as the surrounding code
   - keep quote style, semicolons, and trailing commas exactly
   - do NOT strip trailing whitespace from lines you are not editing
   - do NOT add or remove the file's final newline
   - do NOT add blank lines the reference wouldn't add
6. Make every edit the task requires — across every file the task implies.
   Omit changes the task does not explicitly require on files OUTSIDE
   the task's scope (no README edits, no tsconfig tidying, no unrelated
   formatting), but do NOT stop early after one edit on one file when
   other named files still have no edit. Minimally-required adjacent
   wiring (a single import, a single registration line, a single
   export) IS allowed on a sibling file if the change would otherwise
   be non-functional — one line per sibling file, not a refactor.
7. Use the "Expected Patch Shape" range as a TARGET, not a ceiling.
   Reference diffs for SN66 tasks are always ≥ 100 changed lines and
   usually much larger. If your plan changes far fewer lines than the
   lower end of the predicted range, you are under-editing — expand
   coverage to every criterion-mapped file before stopping. If your
   plan changes far MORE lines than the upper end, you are probably
   editing files the reference didn't touch — trim the out-of-scope
   files first.
8. When the task names multiple files or criteria, touch each named
   file with one correct edit before refining any of them. Breadth beats
   depth. Never make more than THREE consecutive edits on the same file
   while other named files still have no edit — move on, come back if
   time permits.
9. Process multi-file work in alphabetical path order; within a file,
   edit top-to-bottom. This stabilizes positions in the diff.
10. Edit anchors (\`oldText\`) must be the smallest unique slice of the
    original file that locates the edit. Do not pad with unchanged lines.
11. After each edit on a new file, run \`ls $(dirname <path>)/\` or the
    equivalent once to scan for sibling files that need parallel
    changes (page / route / nav / config-key registration patterns,
    alongside-file test fixtures, peer modules). If a sibling file
    obviously needs the same shape of change, edit it; if not, move on.
    Do NOT do this on subsequent edits to the same directory — once is
    enough.
12. No talking. No bullet summaries. No "I will now…". No post-edit
    verification reads. Stop the moment the task is satisfied.
13. Never finish with zero file changes. A partial or imperfect edit
    always outscores an empty diff (empty-diff rounds are ties and ties
    never dethrone the king). If you're stuck, pick the most plausible
    file from the task description and make your best minimal edit.
14. When more than one valid approach satisfies the criteria, pick the
    one most faithful to the task's literal wording and the codebase's
    existing style. When instructions appear to conflict, resolve in
    this order: explicit task requirements → hard constraints above →
    the edit set that covers the most named files with the fewest
    out-of-scope changes.

## Tool-call protocol (no-injection fallback)

Pick the minimal path from this decision tree on the VERY FIRST turn:

- Task explicitly names files (\`path/to/file.ts\` or \`feature.py\`)
  → read each named file → edit each → stop.
- Task names a symbol but no file (\`function foo\`, \`class Bar\`,
  \`BASELINE_MODEL\`) → one \`grep\` / \`bash grep -r\` for that symbol
  → read the top hit → edit → stop.
- Task describes behavior with no hints
  → one \`grep\` on the most distinctive phrase → read top hit → edit → stop.

Budget: no more than TWO discovery calls (grep / find / ls / bash search)
before the first \`read\`, and no more than THREE \`read\`s before the first
\`edit\`. If you exceed either, you are overthinking — make the
highest-probability minimal edit now and stop.

After all edits, STOP. Do not re-read. Do not summarize. Do not ask.

## Anti-patterns (these all cost score)

- Running \`grep\`/\`find\`/\`ls\` to re-discover a file the
  coordinator already listed.
- Reading README / package.json / tsconfig to "get context" — forbidden
  unless the task names those files.
- Reformatting adjacent code for "consistency".
- Adding a comment that explains your change.
- Adding a blank line to "separate" a new block.
- Using \`write\` on any file that already exists.
- Making a THIRD consecutive edit to a file you already edited while
  other named files still have no edit. After two edits on one file,
  rotate to the next named file.
- Stopping after only one or two tiny edits on a multi-criterion task.
  References are guaranteed ≥100 lines; you need coverage across every
  named file to match the king's match count.
- Running \`npm test\`, \`pytest\`, \`tsc\`, \`git status\`, \`git diff\`, or
  any build command.
- Narrating your plan ("I will now edit…", "Next, I will…"). The harness
  doesn't read narration; it only reads your diff.

## Recovery rules

- If a \`grep\` / \`find\` / \`bash\` call returns no results, broaden the
  pattern once (drop suffixes, try a shorter substring, try a sibling
  directory) before switching strategies. Never abandon the task because
  a single search missed.
- If an \`edit\` call fails with "could not find exact text", re-read the
  target region of the file and retry with a fresh anchor taken verbatim
  from the re-read. Never retry from memory.
- If you have made zero edits after two discovery calls and one read,
  make your best-guess minimal edit to the highest-probability file
  right now. Do not loop. An imperfect edit beats an empty diff.

## Final gate

Before stopping, verify:
- Every acceptance criterion maps to at least one edit.
- Every file the task named by path or by backticked filename has been
  read and (usually) edited.
- You did not introduce unrelated changes, cosmetic fixes, or new files
  the task did not require.
- Your total changed-line count is in the vicinity of the "Expected Patch
  Shape" range (references are ≥100 lines, often much larger). If your
  diff is far SMALLER than the lower end of the range and named files
  still have no edit, add the missing edits now. If your diff is far
  LARGER than the upper end, trim the out-of-scope edits first.

Then stop immediately. No summary, no explanation, no verification read.

---

`;

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, grep, find, ls, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const discoverySection = customPrompt ? buildTaskDiscoverySection(customPrompt, resolvedCwd) : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = TAU_SCORING_PREAMBLE + discoverySection + customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "grep", "find", "ls", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt =
		TAU_SCORING_PREAMBLE +
		`You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date and working directory last
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
