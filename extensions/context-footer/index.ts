/**
 * Custom footer: shows context usage as "tokens/window (percent%)"
 * instead of the built-in "percent%/window" (e.g. "16k/128k (12.7%)").
 *
 * Replicates the built-in footer (usage stats, cache hit rate, cost, model
 * + thinking level, git branch, extension statuses) using only public
 * extension APIs, so nothing else about the footer changes.
 *
 * Install:
 *   Drop this directory into ~/.pi/agent/extensions/  (global)
 *   or .pi/extensions/  (project-local), then run /reload or restart pi.
 * Remove the directory to restore the built-in footer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Helpers (mirror the built-in footer internals)
// ---------------------------------------------------------------------------

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function addUsage(totals: UsageTotals, usage: UsageLike): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatCwdForFooter(cwd: string, home?: string): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const insideHome = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!insideHome) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

/** Auto-compaction flag: pi defaults to enabled; project settings override global. */
function isAutoCompactionEnabled(cwd: string): boolean {
	const read = (file: string): Record<string, any> | undefined => {
		try {
			return JSON.parse(readFileSync(file, "utf8"));
		} catch {
			return undefined;
		}
	};
	const globalSettings = read(join(homedir(), ".pi", "agent", "settings.json"));
	const projectSettings = read(join(cwd, ".pi", "settings.json"));
	return (
		projectSettings?.compaction?.enabled ??
		globalSettings?.compaction?.enabled ??
		true
	);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let tuiRef: TUI | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const autoIndicator = isAutoCompactionEnabled(ctx.sessionManager.getCwd()) ? " (auto)" : "";

		ctx.ui.setFooter((tui, theme, footerData) => {
			tuiRef = tui;
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				invalidate() {
					// Nothing cached: every render() recomputes from ctx.
				},
				dispose() {
					unsubscribe();
				},
				render(width: number): string[] {
					// ---- cumulative usage across all entries (mirrors built-in footer) ----
					const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
					let latestCacheHitRate: number | undefined;
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const usage = entry.message.usage;
							addUsage(totals, usage);
							const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
							latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
						} else if (
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.usage
						) {
							addUsage(totals, entry.message.usage);
						} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
							addUsage(totals, entry.usage);
						}
					}

					// ---- context usage: tokens/window (percent%) ----
					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const percentValue = contextUsage?.percent ?? 0;
					const percentStr = contextUsage?.percent !== null ? percentValue.toFixed(1) : "?";
					const contextDisplay =
						percentStr === "?"
							? `?/${formatTokens(contextWindow)}${autoIndicator}`
							: `${formatTokens(contextUsage?.tokens ?? 0)}/${formatTokens(contextWindow)} (${percentStr}%)${autoIndicator}`;
					let contextStr: string;
					if (percentValue > 90) {
						contextStr = theme.fg("error", contextDisplay);
					} else if (percentValue > 70) {
						contextStr = theme.fg("warning", contextDisplay);
					} else {
						contextStr = contextDisplay;
					}

					// ---- stats line ----
					const parts: string[] = [];
					if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
					if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
					if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
					if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
					if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
						parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					}
					const subscription = ctx.model?.provider === "kimi-coding";
					if (totals.cost || subscription) {
						parts.push(`$${totals.cost.toFixed(3)}${subscription ? " (sub)" : ""}`);
					}
					parts.push(contextStr);
					if (process.env.PI_EXPERIMENTAL === "1") {
						parts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
					}
					let statsLeft = parts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					// ---- model name on the right ----
					const modelName = ctx.model?.id || "no-model";
					let rightSideWithoutProvider = modelName;
					if (ctx.model?.reasoning) {
						const level = ctx.thinkingLevel || "off";
						rightSideWithoutProvider =
							level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
					}
					let rightSide = rightSideWithoutProvider;
					const minPadding = 2;
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
						if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
							rightSide = rightSideWithoutProvider;
						}
					}
					const rightSideWidth = visibleWidth(rightSide);
					let statsLine: string;
					if (statsLeftWidth + minPadding + rightSideWidth <= width) {
						statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
					} else {
						const availableForRight = width - statsLeftWidth - minPadding;
						if (availableForRight > 0) {
							const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
							statsLine =
								statsLeft +
								" ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight))) +
								truncatedRight;
						} else {
							statsLine = statsLeft;
						}
					}

					// ---- assemble lines (dim parts separately so color codes don't bleed) ----
					let pwd = formatCwdForFooter(ctx.sessionManager.getCwd(), homedir());
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					const dimStatsLeft = theme.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length);
					const dimRemainder = theme.fg("dim", remainder);

					const lines = [
						truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
						dimStatsLeft + dimRemainder,
					];

					const statuses = footerData.getExtensionStatuses();
					if (statuses.size > 0) {
						const sorted = Array.from(statuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text));
						lines.push(truncateToWidth(sorted.join(" "), width, theme.fg("dim", "...")));
					}
					return lines;
				},
			};
		});
	});

	// Keep the footer fresh after session state changes that may not redraw the UI.
	pi.on("message_end", () => tuiRef?.requestRender());
	pi.on("agent_settled", () => tuiRef?.requestRender());
	pi.on("session_compact", () => tuiRef?.requestRender());
}
