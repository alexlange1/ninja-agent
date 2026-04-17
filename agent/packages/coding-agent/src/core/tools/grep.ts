import { createInterface } from "node:readline";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { readFileSync, statSync } from "fs";
import { globSync } from "glob";
import path from "path";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { ensureTool } from "../../utils/tools-manager.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { resolveToCwd } from "./path-utils.js";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.js";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (for example SSH).
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Read file contents for context lines */
	readFile: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: (p) => statSync(p).isDirectory(),
	readFile: (p) => readFileSync(p, "utf-8"),
};

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem plus ripgrep */
	operations?: GrepOperations;
}

function formatGrepCall(
	args: { pattern: string; path?: string; glob?: string; limit?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const glob = str(args?.glob);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}

function formatGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}

	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	if (matchLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		if (linesTruncated) warnings.push("some lines truncated");
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		parameters: grepSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			},
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				let settled = false;
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						fn();
					}
				};

				(async () => {
					try {
						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const ops = customOps ?? defaultGrepOperations;
						let isDirectory: boolean;
						try {
							isDirectory = await ops.isDirectory(searchPath);
						} catch {
							settle(() => reject(new Error(`Path not found: ${searchPath}`)));
							return;
						}

						const contextValue = context && context > 0 ? context : 0;
						const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
						const formatPath = (filePath: string): string => {
							if (isDirectory) {
								const relative = path.relative(searchPath, filePath);
								if (relative && !relative.startsWith("..")) {
									return relative.replace(/\\/g, "/");
								}
							}
							return path.basename(filePath);
						};

						const fileCache = new Map<string, string[]>();
						const getFileLines = async (filePath: string): Promise<string[]> => {
							let lines = fileCache.get(filePath);
							if (!lines) {
								try {
									const content = await ops.readFile(filePath);
									lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
								} catch {
									lines = [];
								}
								fileCache.set(filePath, lines);
							}
							return lines;
						};

						let linesTruncated = false;
						const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
							const relativePath = formatPath(filePath);
							const lines = await getFileLines(filePath);
							if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
							const block: string[] = [];
							const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
							const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
							for (let current = start; current <= end; current++) {
								const lineText = lines[current - 1] ?? "";
								const sanitized = lineText.replace(/\r/g, "");
								const isMatchLine = current === lineNumber;
								const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
								if (wasTruncated) linesTruncated = true;
								if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
								else block.push(`${relativePath}-${current}- ${truncatedText}`);
							}
							return block;
						};

						const assembleOutput = (
							outputLines: string[],
							matchLimitReached: boolean,
						): { text: string; details?: GrepToolDetails } => {
							const rawOutput = outputLines.join("\n");
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let output = truncation.content;
							const details: GrepToolDetails = {};
							const notices: string[] = [];
							if (matchLimitReached) {
								notices.push(
									`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.matchLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (linesTruncated) {
								notices.push(
									`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
								);
								details.linesTruncated = true;
							}
							if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
							return { text: output, details: Object.keys(details).length > 0 ? details : undefined };
						};

						const rgPath = await ensureTool("rg", true);
						if (!rgPath) {
							// Pure-Node fallback when ripgrep is unavailable
							// (e.g. offline sandbox environments).
							const fileGlob = glob || "**/*";
							let files: string[];
							try {
								files = isDirectory
									? globSync(fileGlob, {
											cwd: searchPath,
											dot: true,
											nodir: true,
											absolute: true,
											ignore: ["**/node_modules/**", "**/.git/**"],
										})
									: [searchPath];
							} catch (err: any) {
								settle(() => reject(new Error(`Glob fallback failed: ${err?.message || err}`)));
								return;
							}

							const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
							const flags = ignoreCase ? "gi" : "g";
							let regex: RegExp;
							try {
								regex = new RegExp(literal ? escape(pattern) : pattern, flags);
							} catch (err: any) {
								settle(() => reject(new Error(`Invalid regex: ${err?.message || err}`)));
								return;
							}

							const matches: Array<{ filePath: string; lineNumber: number }> = [];
							let matchCount = 0;
							let matchLimitReached = false;
							let aborted = false;
							const abortListener = () => {
								aborted = true;
							};
							signal?.addEventListener("abort", abortListener, { once: true });

							outer: for (const file of files) {
								if (aborted) break;
								const lines = await getFileLines(file);
								for (let i = 0; i < lines.length; i++) {
									regex.lastIndex = 0;
									if (regex.test(lines[i])) {
										matches.push({ filePath: file, lineNumber: i + 1 });
										matchCount++;
										if (matchCount >= effectiveLimit) {
											matchLimitReached = true;
											break outer;
										}
									}
								}
							}
							signal?.removeEventListener("abort", abortListener);

							if (aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (matchCount === 0) {
								settle(() =>
									resolve({ content: [{ type: "text", text: "No matches found" }], details: undefined }),
								);
								return;
							}
							const outputLines: string[] = [];
							for (const m of matches) {
								const block = await formatBlock(m.filePath, m.lineNumber);
								outputLines.push(...block);
							}
							const { text, details } = assembleOutput(outputLines, matchLimitReached);
							settle(() => resolve({ content: [{ type: "text", text }], details }));
							return;
						}

						const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
						if (ignoreCase) args.push("--ignore-case");
						if (literal) args.push("--fixed-strings");
						if (glob) args.push("--glob", glob);
						args.push(pattern, searchPath);

						const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						let matchCount = 0;
						let matchLimitReached = false;
						let aborted = false;
						let killedDueToLimit = false;
						const outputLines: string[] = [];

						const cleanup = () => {
							rl.close();
							signal?.removeEventListener("abort", onAbort);
						};
						const stopChild = (dueToLimit = false) => {
							if (!child.killed) {
								killedDueToLimit = dueToLimit;
								child.kill();
							}
						};
						const onAbort = () => {
							aborted = true;
							stopChild();
						};
						signal?.addEventListener("abort", onAbort, { once: true });
						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						// Collect matches during streaming, then format them after rg exits.
						const matches: Array<{ filePath: string; lineNumber: number }> = [];
						rl.on("line", (line) => {
							if (!line.trim() || matchCount >= effectiveLimit) return;
							let event: any;
							try {
								event = JSON.parse(line);
							} catch {
								return;
							}
							if (event.type === "match") {
								matchCount++;
								const filePath = event.data?.path?.text;
								const lineNumber = event.data?.line_number;
								if (filePath && typeof lineNumber === "number") matches.push({ filePath, lineNumber });
								if (matchCount >= effectiveLimit) {
									matchLimitReached = true;
									stopChild(true);
								}
							}
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
						});
						child.on("close", async (code) => {
							cleanup();
							if (aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (!killedDueToLimit && code !== 0 && code !== 1) {
								const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
								settle(() => reject(new Error(errorMsg)));
								return;
							}
							if (matchCount === 0) {
								settle(() =>
									resolve({ content: [{ type: "text", text: "No matches found" }], details: undefined }),
								);
								return;
							}

							// Format matches after streaming finishes so custom readFile() backends can be async.
							for (const match of matches) {
								const block = await formatBlock(match.filePath, match.lineNumber);
								outputLines.push(...block);
							}

							const { text, details } = assembleOutput(outputLines, matchLimitReached);
							settle(() => resolve({ content: [{ type: "text", text }], details }));
						});
					} catch (err) {
						settle(() => reject(err as Error));
					}
				})();
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}

/** Default grep tool using process.cwd() for backwards compatibility. */
export const grepToolDefinition = createGrepToolDefinition(process.cwd());
export const grepTool = createGrepTool(process.cwd());
