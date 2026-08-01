/**
 * pin-bottom — keep the text input and footer pinned to the bottom of the
 * terminal as a fixed bottom bar.
 *
 * The input editor + footer are rendered as a separate, always-visible bar at
 * the bottom row(s) of the screen, while the chat content above it scrolls
 * internally (like `less` or `vim`).
 *
 * To make the wheel scroll the chat WITHOUT taking the mouse away from the
 * terminal (so click-drag text selection keeps working natively), pi is moved
 * into the alternate screen with alternate-scroll mode enabled (`?1007h`):
 * the terminal then converts wheel events into SS3 up/down arrow sequences
 * (`ESC O A` / `ESC O B`) sent to the app, which are byte-distinguishable
 * from real keyboard arrows (CSI `ESC [ A` / `ESC [ B`, or kitty-protocol
 * sequences). No mouse reporting mode is ever enabled, so alacritty and other
 * terminals keep their native click-drag selection exactly as before.
 *
 * Scrolling:
 *   Mouse wheel   scroll back/forward
 *   PageUp/PageDown  page-scroll (only while the editor is focused;
 *                    default = full viewport; set page_step to change)
 *   Enter         while scrolled back, sending a message jumps back to latest
 *
 * When the chat is shorter than the screen, the bar sits at the bottom with
 * blank filler between it and the content. When the chat is long, the viewport
 * shows the newest messages by default and keeps the bar fixed while you
 * scroll through history.
 *
 * Configuration (optional):
 *   All settings live in the `pin_bottom` block of pi's settings.json
 *   (~/.pi/agent/settings.json, a.k.a. ~/.config/pi/settings.json) and can be
 *   overridden per-environment (snake_case keys; the old camelCase `pinBottom`
 *   block and `wheelStep` key are still accepted):
 *
 *     {
 *       "pin_bottom": {
 *         "wheel": true,     // false = keys-only scrolling, no alternate screen
 *         "wheel_step": 1,   // lines per wheel event (alacritty sends ~3 events
 *                             //   per notch, so 1 ≈ 3 lines/notch = native speed)
 *         "page_step": 10    // lines per PageUp/PageDown (default: full viewport)
 *       }
 *     }
 *
 *   If the block is absent, the defaults above apply. Environment overrides:
 *   PI_PIN_BOTTOM_WHEEL (0/1), PI_PIN_BOTTOM_WHEEL_STEP, PI_PIN_BOTTOM_PAGE_STEP.
 *   Run /pin-bottom to see the current settings.
 *
 * Install:
 *   Drop this directory into ~/.config/pi/extensions/  (global)
 *   or .pi/extensions/  (project-local), then run /reload or restart pi.
 * Remove the directory to restore the default layout.
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, isKeyRelease, Key, matchesKey, Text, TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let patched = false;
let tuiRef: TUI | undefined;
let themeRef: { fg: (color: string, s: string) => string } | undefined;
/** How many lines above the latest content the viewport is showing (0 = latest). */
let scrollOffset = 0;
/** Height of the scrollable content area (rows minus bottom bar), from last render. */
let pageSize = 20;

const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[?1007h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l\x1b[?1007l";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface PinBottomConfig {
	/** Wheel scrolling (requires the alternate screen + alternate-scroll mode).
	 *  When false, scrolling is keys-only (PageUp/PageDown) and the terminal
	 *  screen is left untouched. */
	wheel: boolean;
	/** Lines per wheel event. Alacritty already converts one notch into several
	 *  SS3 arrow events (its `scrolling.multiplier`, default 3), so 1 means one
	 *  notch ≈ 3 lines (native scrollback speed); higher = faster. */
	wheelStep: number;
	/** Lines per PageUp/PageDown press. Default (unset): one full viewport
	 *  page, matching alacritty's native shift+PageUp. */
	pageStep?: number;
}

function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

/** Parse a positive integer line count (env or file value). */
function parseStep(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n) || n < 1) return fallback;
	return Math.min(n, 1000);
}

/** Read the `pin_bottom` block from settings.json (the same file pi uses), then
 *  apply PI_PIN_BOTTOM_WHEEL / PI_PIN_BOTTOM_WHEEL_STEP environment variable
 *  overrides.
 *
 *  settings.json (snake_case, camelCase `pinBottom` block also accepted):
 *    { "pin_bottom": { "wheel": true, "wheel_step": 1 } } */
function readConfig(): PinBottomConfig {
	const cfg: PinBottomConfig = { wheel: true, wheelStep: 1 };

	const agentDir = process.env.PI_CODING_AGENT_DIR ? expandHome(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
	const candidates = [join(agentDir, "settings.json"), expandHome("~/.config/pi/settings.json")];
	for (const file of candidates) {
		try {
			const settings = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
			const block = (settings.pin_bottom ?? settings.pinBottom) as Record<string, unknown> | undefined;
			if (!block || typeof block !== "object") break;
			if (typeof block.wheel === "boolean") cfg.wheel = block.wheel;
			// snake_case preferred, camelCase accepted for compatibility
			if (block.wheel_step !== undefined) cfg.wheelStep = parseStep(String(block.wheel_step), cfg.wheelStep);
			else if (block.wheelStep !== undefined) cfg.wheelStep = parseStep(String(block.wheelStep), cfg.wheelStep);
			const ps =
				block.page_step !== undefined ? parseStep(String(block.page_step), 0) :
				block.pageStep !== undefined ? parseStep(String(block.pageStep), 0) : 0;
			if (ps > 0) cfg.pageStep = ps;
			break; // first readable settings.json wins
		} catch {
			// try the next location
		}
	}

	const envWheel = process.env.PI_PIN_BOTTOM_WHEEL;
	if (envWheel !== undefined) {
		const v = envWheel.trim().toLowerCase();
		cfg.wheel = !(v === "0" || v === "false" || v === "off" || v === "no");
	}
	if (process.env.PI_PIN_BOTTOM_WHEEL_STEP !== undefined) {
		cfg.wheelStep = parseStep(process.env.PI_PIN_BOTTOM_WHEEL_STEP, cfg.wheelStep);
	}
	if (process.env.PI_PIN_BOTTOM_PAGE_STEP !== undefined) {
		const ps = parseStep(process.env.PI_PIN_BOTTOM_PAGE_STEP, 0);
		if (ps > 0) cfg.pageStep = ps;
	}

	return cfg;
}

const config = readConfig();
/** Whether we actually entered the alternate screen (only then restore it on exit). */
let altScreenEntered = false;

// ---------------------------------------------------------------------------
// Kitty/iTerm2 image detection (pi-tui internals aren't re-exported, so we
// replicate the small bits needed to avoid slicing through an image's rows).
// ---------------------------------------------------------------------------

const KITTY_PREFIX = "\x1b_G";
const ITERM2_PREFIX = "\x1b]1337;";

function isImageLine(line: string): boolean {
	return line.includes(KITTY_PREFIX) || line.includes(ITERM2_PREFIX);
}

/** Parse `r=N` (row count) from a kitty image header line. */
function kittyImageRows(line: string): number {
	const start = line.indexOf(KITTY_PREFIX);
	if (start === -1) return 1;
	const paramsStart = start + KITTY_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return 1;
	for (const param of line.slice(paramsStart, paramsEnd).split(",")) {
		const [key, value] = param.split("=", 2);
		if (key === "r" && value !== undefined) {
			const n = Number(value);
			if (Number.isInteger(n) && n > 0) return n;
		}
	}
	return 1;
}

/** Number of rows an image at `index` occupies (image line + blank rows). */
function imageReservedRows(lines: string[], index: number): number {
	const rows = kittyImageRows(lines[index] ?? "");
	if (rows <= 1) return 1;
	const maxRows = Math.min(rows, lines.length - index);
	let reserved = 1;
	while (reserved < maxRows) {
		const line = lines[index + reserved] ?? "";
		if (isImageLine(line) || visibleWidth(line) > 0) break;
		reserved++;
	}
	return reserved;
}

/**
 * Adjust a viewport slice [start, end) so it never begins or ends in the
 * middle of a multi-row image. Images don't nest, so one pass suffices.
 */
function adjustSliceForImages(lines: string[], start: number, end: number): [number, number] {
	// Don't begin mid-image: if the slice starts inside an image's row span,
	// pull the window up to include the image header (losing that many lines
	// at the bottom of the window).
	for (let i = start - 1; i >= Math.max(0, start - 64); i--) {
		if (!isImageLine(lines[i])) continue;
		const rows = imageReservedRows(lines, i);
		if (i + rows > start) {
			const pullUp = Math.min(start - i, end - start);
			start -= pullUp;
			end -= pullUp;
		}
		break;
	}
	// Don't split an image at the bottom edge: if the last visible line is an
	// image that extends past `end`, move the window down to include it
	// (losing that many lines at the top of the window).
	const lastVisible = end - 1;
	if (lastVisible >= 0 && isImageLine(lines[lastVisible])) {
		const rows = imageReservedRows(lines, lastVisible);
		if (lastVisible + rows > end) {
			const extendDown = Math.min(lastVisible + rows, lines.length) - end;
			start += extendDown;
			end += extendDown;
		}
	}
	return [start, end];
}

// ---------------------------------------------------------------------------
// Render patch: viewport slice + fixed bottom bar
// ---------------------------------------------------------------------------

/**
 * Find the top-level child that holds the input editor — i.e. where the
 * "bottom bar" (editor + below-editor widgets + footer) begins.
 */
function findEditorContainerIndex(children: any[], focused: any): number {
	// The container that directly holds the focused component.
	for (let i = 0; i < children.length; i++) {
		const sub = children[i]?.children;
		if (Array.isArray(sub) && sub.includes(focused)) return i;
	}
	// A container holding an editor / input / selector component.
	for (let i = 0; i < children.length; i++) {
		const sub = children[i]?.children;
		if (!Array.isArray(sub) || sub.length === 0) continue;
		const names = sub.map((c: any) => c?.constructor?.name ?? "");
		if (names.some((name: string) => /(Editor|Input|Selector)$/.test(name))) return i;
	}
	// Fallback: the bottom bar is the last three children
	// [editorContainer, belowEditorWidgets, footer].
	if (children.length >= 3) return children.length - 3;
	return -1;
}

function concat(parts: string[][]): string[] {
	const out: string[] = [];
	for (const part of parts) {
		for (const line of part) out.push(line);
	}
	return out;
}

function patchTuiRender(): void {
	if (patched) return;
	patched = true;

	const proto = TUI.prototype as unknown as {
		render(width: number): string[];
	};

	proto.render = function (this: TUI, width: number): string[] {
		tuiRef = this;

		const children = (this as any).children as any[];
		if (!Array.isArray(children)) return proto.render.call(this, width);

		const parts: string[][] = [];
		for (const child of children) parts.push(child.render(width));

		const editorIndex = findEditorContainerIndex(children, (this as any).focusedComponent);
		if (editorIndex === -1) return concat(parts);

		const contentLines = concat(parts.slice(0, editorIndex));
		const barLines = concat(parts.slice(editorIndex));

		const height = (this as any).terminal?.rows;
		if (typeof height !== "number" || height <= 0) {
			return [...contentLines, ...barLines];
		}

		const available = Math.max(0, height - barLines.length);
		pageSize = Math.max(1, available);
		const maxOffset = Math.max(0, contentLines.length - available);
		const offset = Math.min(Math.max(0, scrollOffset), maxOffset);
		scrollOffset = offset; // write back the clamped value so PageDown responds immediately

		let visible: string[];
		if (contentLines.length <= available) {
			visible = contentLines;
		} else {
			let end = contentLines.length - offset;
			let start = Math.max(0, end - available);
			[start, end] = adjustSliceForImages(contentLines, start, end);
			visible = contentLines.slice(start, end);
		}

		const out: string[] = [];
		for (const line of visible) out.push(line);
		const shortage = height - (out.length + barLines.length);
		if (shortage > 0) {
			for (let i = 0; i < shortage; i++) out.push("");
		}
		for (const line of barLines) out.push(line);

		// When scrolled back, replace the top content line with a return hint.
		if (offset > 0 && visible.length > 0) {
			const hintText = config.wheel
				? "↑ scrolled · scroll down / PageDown to return to latest"
				: "↑ scrolled · PageDown to return to latest";
			const hint = truncateToWidth(themeRef ? themeRef.fg("dim", hintText) : hintText, width);
			out[0] = hint;
		}

		return out;
	};
}

/**
 * Enter the alternate screen + alternate scroll before the TUI starts, so the
 * terminal converts wheel events into SS3 arrows instead of reporting mouse
 * events (keeping native click-drag selection intact).
 */
function patchTuiStart(): void {
	const proto = TUI.prototype as unknown as {
		start(...args: unknown[]): unknown;
	};
	const origStart = proto.start;
	if (!origStart || (origStart as any).__pinBottomPatched) return;
	(origStart as any).__pinBottomPatched = true;

	proto.start = function (this: TUI, ...args: unknown[]): unknown {
		try {
			if (process.stdout.isTTY && config.wheel) {
				(this as any).terminal?.write?.(ENTER_ALT_SCREEN);
				altScreenEntered = true;
			}
		} catch {
			/* ignore */
		}
		return origStart.call(this, ...args);
	};
}

// ---------------------------------------------------------------------------
// Scroll input handling
// ---------------------------------------------------------------------------

/** True when the given component is the chat input editor. */
function isChatEditor(focused: any): boolean {
	return focused instanceof Editor || focused?.constructor?.name?.endsWith("Editor");
}

function onTerminalInput(data: string): { consume?: boolean; data?: string } | undefined {
	// The kitty protocol (flag 2, enabled by pi) reports key releases too; they
	// are filtered here just like pi does for focused components. Repeats are
	// kept so holding a key keeps scrolling.
	if (isKeyRelease(data)) return undefined;

	const tui = tuiRef;
	if (!tui) return undefined;

	const focused = (tui as any).focusedComponent;
	const editorFocused = isChatEditor(focused);

	// Wheel events arrive as SS3 arrows (ESC O A / ESC O B) thanks to
	// alternate-scroll mode in the alternate screen. These bytes are never
	// produced by real arrow keys (keyboard arrows are CSI or kitty-protocol
	// sequences), so they can be consumed freely. Skipped entirely when the
	// wheel option is off.
	if (config.wheel && (data === "\x1bOA" || data === "\x1bOB")) {
		if (editorFocused) {
			scrollOffset = Math.max(0, scrollOffset + (data === "\x1bOA" ? config.wheelStep : -config.wheelStep));
			tui.requestRender();
			return { consume: true };
		}
		// Selector/overlay focused: let it handle up/down itself (the wheel
		// then scrolls that list).
		return undefined;
	}

	// PageUp/PageDown only take over while the editor is focused (selectors
	// and overlays keep their own paging).
	if (!editorFocused) return undefined;

	const pageStep = config.pageStep ?? pageSize;
	if (matchesKey(data, Key.pageUp)) {
		scrollOffset += pageStep;
		tui.requestRender();
		return { consume: true };
	}
	if (matchesKey(data, Key.pageDown)) {
		scrollOffset = Math.max(0, scrollOffset - pageStep);
		tui.requestRender();
		return { consume: true };
	}
	if (matchesKey(data, Key.enter)) {
		// Sending a message: snap back to the latest view (don't consume —
		// the editor still submits the message).
		if (scrollOffset > 0) {
			scrollOffset = 0;
			tui.requestRender();
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	patchTuiRender();
	patchTuiStart();

	// Restore the primary screen when pi exits so the shell isn't left in the
	// alternate screen (only if we actually entered it, and only on a TTY).
	process.once("exit", () => {
		try {
			if (process.stdout.isTTY && altScreenEntered) fs.writeSync(1, LEAVE_ALT_SCREEN);
		} catch {
			/* ignore */
		}
	});

	pi.registerCommand("pin-bottom", {
		description: "Show pin-bottom scroll configuration",
		handler: async (_args, ctx) => {
			const wheelStatus = config.wheel
				? `wheel ON (${config.wheelStep} line(s) per wheel event, ~${config.wheelStep * 3} per notch in alacritty)`
				: "wheel OFF (keys-only)";
			const how =
				"config: settings.json → \"pin_bottom\": { wheel, wheel_step, page_step } (camelCase legacy also accepted) · env: PI_PIN_BOTTOM_WHEEL, PI_PIN_BOTTOM_WHEEL_STEP, PI_PIN_BOTTOM_PAGE_STEP";
			const pageStatus = config.pageStep ? `${config.pageStep} line(s)` : "full-page";
			ctx.ui.notify(`${wheelStatus} · PageUp/PageDown ${pageStatus} scroll · arrows = editor history · ${how}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		scrollOffset = 0;

		// Zero-line widget: capture the TUI + theme for the scroll hint.
		ctx.ui.setWidget("pin-bottom-capture", (tui, theme) => {
			tuiRef = tui;
			themeRef = theme as { fg: (color: string, s: string) => string };
			return new Text("");
		});

		ctx.ui.onTerminalInput(onTerminalInput);
	});
}
