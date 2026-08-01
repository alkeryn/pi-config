/**
 * modal_keybinds — modal (multi-key) keybindings for pi.
 *
 * Lets you bind key *sequences* like `ctrl+x` then `l` to actions, similar to
 * emacs key chords or vim leader keys. Any depth is supported (`alt+x` `g` `b`).
 *
 * Configuration (later sources win, merged per prefix):
 *  1. built-in defaults below,
 *  2. legacy `~/.pi/agent/modal_keybinds.json`,
 *  3. the `"modal"` block inside `~/.pi/agent/keybindings.json` (recommended):
 *
 *     {
 *       "app.message.copy": ["ctrl+shift+x"],   // optional: moves copy off ctrl+x
 *       "modal": {
 *         "timeout_ms": 7000,   // omitted = no timeout (modal waits forever)
 *         "bindings": {
 *           "ctrl+x": {
 *             "c": { "type": "compact", "label": "Compact conversation" },
 *             "m": { "type": "model", "label": "Switch model" },
 *             "e": { "type": "action", "name": "app.editor.external", "label": "Open external editor" }
 *           }
 *         }
 *       }
 *     }
 *
 * The `action` type invokes an app action by name: it looks up the handler pi
 * registered for it (the focused editor's `actionHandlers` map) and calls it
 * directly — the same handler a keybinding press would run, but without any
 * keybinding lookup, so it works even if the action is unbound or rebound.
 * The `key` type instead replays a keypress through pi's input pipeline for
 * keys that aren't app actions (e.g. editor navigation chords).
 *
 * pi ignores unknown keys and non-array values in keybindings.json, so the
 * `"modal"` block is inert as far as pi's own keybinding engine is concerned.
 *
 * How it works:
 *  - A single TUI-level input listener watches for first-level prefix keys
 *    (e.g. `ctrl+x`) — but only while the input editor is focused. When focus
 *    is elsewhere (selectors like `/scoped-models`, overlays) the key passes
 *    through untouched, so `ctrl+x` keeps its native meaning there ("clear").
 *  - When a prefix fires, a small menu widget is shown above the editor and the
 *    listener grabs the *next* key. `matchesKey` from pi-tui is used to match
 *    the raw input against configured key ids.
 *  - On a match the action executes (or the chain descends one level), on
 *    `escape`/`ctrl+c` the sequence is cancelled, and if `timeout_ms` is set
 *    the sequence auto-cancels once it elapses.
 *  - No `pi.registerShortcut` is used, so pi never emits shortcut-conflict
 *    warnings and no built-in key is "reserved" from modal prefixes.
 */

import { CustomEditor, ModelSelectorComponent, copyToClipboard, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Editor, Text, isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An action leaves the modal chain and does something. */
export type Action = {
	type: string;
	/** Optional short label shown in the modal menu widget. */
	label?: string;
	[key: string]: unknown;
};

/** A binding is either an action (leaf) or a map of keyId → Binding (nesting). */
export type Binding = Action | { [key: string]: Binding };

export interface ModalConfig {
	/** How long to wait for the next key before cancelling. Default 5000. */
	timeout_ms?: number;
	/** prefix keyId → map of second-level keyId → binding. */
	bindings?: { [prefix: string]: Binding };
}

/** Custom JS handlers, referenced from config via `{ "type": "handler", "name": "..." }`. */
export type CustomHandler = (ctx: ExtensionContext, pi: ExtensionAPI) => void | Promise<void>;

/**
 * Cross-extension handler dispatch via pi's shared event bus (`pi.events`).
 *
 * A `handler` name containing a `:` is an event channel: modal_keybinds emits
 * `{ ctx, pi }` on it and lets other extensions handle it. The name is
 * literally the channel, so any extension may subscribe to it without
 * modal_keybinds knowing it exists; names without a colon are local handlers
 * in `handlers`.
 *
 * Note: `pi.events.emit` is fire-and-forget — if nothing subscribes to a
 * channel, the key press silently does nothing.
 */

// ---------------------------------------------------------------------------
// Custom handlers (extend this registry to add JS actions)
// ---------------------------------------------------------------------------

export const handlers: Record<string, CustomHandler> = {
	/** Demo: flip the `editor` and `compact` example widgets shown above the editor. */
	toggleDemoWidget: (ctx) => {
		const key = "modal_keybinds_demo";
		if (ctx.ui.getEditorText().includes("demo")) {
			ctx.ui.setWidget(key, undefined);
			ctx.ui.notify("modal_keybinds: demo widget cleared", "info");
		} else {
			ctx.ui.setWidget(key, ["demo widget from handler action", "try `alt+x` `d` again to clear it"]);
			ctx.ui.notify("modal_keybinds: demo widget shown", "info");
		}
	},
};

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ModalConfig = {
	bindings: {
		// Default prefixes use `alt+x` / `alt+g` so they don't shadow common
		// editor chords out of the box. Any key works as a prefix — prefixes
		// only fire while the input editor is focused; in selectors/overlays
		// the key passes through untouched.
		"alt+x": {
			c: { type: "compact", label: "Compact conversation" },
			m: { type: "model", label: "Switch model" },
			e: { type: "editorAppend", text: "\n", label: "Append newline" },
			f: { type: "message", text: "Fix the latest errors in the code.", label: "Fix errors" },
			d: { type: "handler", name: "toggleDemoWidget", label: "Toggle demo widget" },
			// Nested chain: alt+x, then g, then b/r/s.
			g: {
				b: { type: "notify", message: "you pressed alt+x g b", label: "agb" },
				r: { type: "notify", message: "you pressed alt+x g r", label: "agr" },
				s: { type: "paste", text: "hello from alt+x g s", label: "Paste hello" },
			},
		},
	},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KNOWN_ACTION_TYPES = new Set([
	"notify",
	"message",
	"editor",
	"editorAppend",
	"editorPrepend",
	"paste",
	"compact",
	"model",
	"copy",
	"key",
	"action",
	"handler",
]);

function isAction(b: Binding): b is Action {
	return typeof b === "object" && b !== null && "type" in b && typeof (b as Action).type === "string";
}

function isBindingMap(b: Binding): b is { [key: string]: Binding } {
	return typeof b === "object" && b !== null && !("type" in b);
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Extract plain text from a message's content parts. */
function messageText(message: { role: string; content?: unknown }): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter(
			(p): p is { type: "text"; text: string } =>
				isPlainObject(p) && p.type === "text" && typeof p.text === "string",
		)
		.map((p) => p.text)
		.join("\n");
}

/** Render a key id for the menu widget: `l` → `L`, keep chords as-is. */
function keyDisplay(keyId: string): string {
	return /^[a-z]$/.test(keyId) ? keyId.toUpperCase() : keyId;
}

function actionDetail(a: Action): string {
	switch (a.type) {
		case "notify":
			return typeof a.message === "string" ? truncate(a.message, 40) : "";
		case "message":
			return typeof a.text === "string" ? truncate(a.text, 40) : "";
		case "editor":
		case "editorAppend":
		case "editorPrepend":
		case "paste":
			return typeof a.text === "string" ? truncate(a.text, 40) : "";
		case "compact":
			return "compact conversation";
		case "model":
			return "open model selector (native /model)";
		case "copy":
			return "copy last assistant message";
		case "key":
			return typeof a.key === "string" ? `replay ${a.key}` : "";
		case "action":
			return typeof a.name === "string" ? `run ${a.name}` : "";
		case "handler":
			return typeof a.name === "string" ? `handler: ${a.name}` : "";
		default:
			return "";
	}
}

function describe(b: Binding): string {
	if (!isAction(b)) return `(${Object.keys(b).length} keys)`;
	const detail = actionDetail(b);
	if (typeof b.label === "string" && b.label) {
		return detail ? `${b.label} — ${detail}` : b.label;
	}
	return detail || b.type;
}

/** Recursively merge plain objects (maps). Scalars/actions from `over` win. */
function deepMerge<T>(base: T, over: T): T {
	if (isPlainObject(base) && isPlainObject(over)) {
		const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
		for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
			const baseV = (base as Record<string, unknown>)[k];
			out[k] = isPlainObject(baseV) && isPlainObject(v) ? deepMerge(baseV, v) : v;
		}
		return out as T;
	}
	return over;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

// --- key id validation -------------------------------------------------------

const MODIFIER_NAMES = new Set(["ctrl", "shift", "alt", "super"]);
const SPECIAL_KEYS = new Set([
	"escape", "esc", "enter", "return", "tab", "space", "backspace", "delete",
	"insert", "clear", "home", "end", "pageup", "pagedown", "up", "down",
	"left", "right",
]);
const SYMBOL_KEYS = new Set([
	"`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$",
	"%", "^", "&", "*", "(", ")", "_", "+", "|", "~", "{", "}", ":", "<", ">", "?",
]);

/** True when `keyId` looks like a valid keybindings.json key id (e.g. `ctrl+shift+x`). */
function isValidKeyId(keyId: string): boolean {
	if (typeof keyId !== "string" || keyId.length === 0) return false;
	const parts = keyId.toLowerCase().split("+");
	const mods = parts.slice(0, -1);
	const key = parts[parts.length - 1] ?? "";
	if (mods.some((m) => !MODIFIER_NAMES.has(m))) return false;
	if (mods.length > 3) return false; // ctrl+shift+alt+key is the max
	if (/^[a-z0-9]$/.test(key)) return true;
	if (/^f([1-9]|1[0-2])$/.test(key)) return true;
	if (SPECIAL_KEYS.has(key)) return true;
	if (SYMBOL_KEYS.has(key)) return true;
	return false;
}

/**
 * Encode a key id (e.g. `ctrl+g`) as the raw terminal bytes a real keypress
 * would produce, so the `key` action can replay it through the TUI's normal
 * input pipeline (input listeners → focused component → its keybinding
 * matching). Uses pi-tui's accepted legacy sequences and CSI-u sequences
 * (parsed regardless of whether the kitty keyboard protocol is active).
 * Returns undefined for keys with no representable encoding (e.g. modified
 * f-keys or super combos, which pi's matcher itself cannot match).
 */
function keyIdToRaw(keyId: string): string | undefined {
	const parts = keyId.toLowerCase().split("+");
	const mods = new Set(parts.slice(0, -1));
	const key = parts[parts.length - 1] ?? "";
	if (mods.has("super")) return undefined; // super cannot be emulated
	const ctrl = mods.has("ctrl");
	const alt = mods.has("alt");
	const shift = mods.has("shift");
	const mod = (shift ? 1 : 0) | (alt ? 2 : 0) | (ctrl ? 4 : 0);

	// Unmodified keys: plain character or a legacy sequence (always accepted).
	if (mod === 0) {
		const legacy: Record<string, string> = {
			escape: "\x1b", esc: "\x1b", enter: "\r", return: "\r",
			tab: "\t", space: " ", backspace: "\x7f",
			up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
			home: "\x1b[H", end: "\x1b[F", pageup: "\x1b[5~", pagedown: "\x1b[6~",
			insert: "\x1b[2~", delete: "\x1b[3~",
			f1: "\x1bOP", f2: "\x1bOQ", f3: "\x1bOR", f4: "\x1bOS",
			f5: "\x1b[15~", f6: "\x1b[17~", f7: "\x1b[18~", f8: "\x1b[19~",
			f9: "\x1b[20~", f10: "\x1b[21~", f11: "\x1b[23~", f12: "\x1b[24~",
		};
		if (key in legacy) return legacy[key];
		if (key.length === 1) return key; // plain letter / digit / symbol
		return undefined;
	}

	// Pure shift or ctrl on navigation keys: legacy modified sequences.
	const navLegacy: Record<string, [string, string]> = {
		up: ["\x1b[a", "\x1bOa"], down: ["\x1b[b", "\x1bOb"],
		right: ["\x1b[c", "\x1bOc"], left: ["\x1b[d", "\x1bOd"],
		insert: ["\x1b[2$", "\x1b[2^"], delete: ["\x1b[3$", "\x1b[3^"],
		pageup: ["\x1b[5$", "\x1b[5^"], pagedown: ["\x1b[6$", "\x1b[6^"],
		home: ["\x1b[7$", "\x1b[7^"], end: ["\x1b[8$", "\x1b[8^"],
	};
	if (!alt && key in navLegacy) {
		if (shift && !ctrl) return navLegacy[key][0];
		if (ctrl && !shift) return navLegacy[key][1];
	}
	if (alt && !ctrl && !shift) {
		const altArrows: Record<string, string> = { up: "\x1bp", down: "\x1bn", right: "\x1bf", left: "\x1bb" };
		if (key in altArrows) return altArrows[key];
	}
	if (shift && !ctrl && !alt && key === "tab") return "\x1b[Z"; // shift+tab

	// Printable keys with modifiers: the raw control char for ctrl (always
	// accepted), uppercase for shift+letter, else a CSI-u sequence
	// \x1b[<codepoint>;<mod+1>u — pi-tui parses those in every terminal mode.
	if (key.length === 1 && /^[\x20-\x7e]$/.test(key)) {
		if (ctrl && !alt && !shift) {
			const raw = ctrlChar(key);
			if (raw !== undefined) return raw;
		}
		if (shift && !ctrl && !alt && /^[a-z]$/.test(key)) return key.toUpperCase();
		return `\x1b[${key.charCodeAt(0)};${mod + 1}u`;
	}

	// Special keys with modifiers via CSI-u functional codepoints.
	const specialCp: Record<string, number> = { space: 32, tab: 9, enter: 13, return: 13, backspace: 127 };
	if (key in specialCp) return `\x1b[${specialCp[key]};${mod + 1}u`;
	const funcNum: Record<string, number> = { insert: 2, delete: 3, pageup: 5, pagedown: 6, home: 7, end: 8 };
	if (key in funcNum) return `\x1b[${funcNum[key]};${mod + 1}~`;
	const arrowLetter: Record<string, string> = { up: "A", down: "B", right: "C", left: "D" };
	if (key in arrowLetter) return `\x1b[1;${mod + 1}${arrowLetter[key]}`;

	return undefined;
}

/** Control character for a printable key, like a real terminal sends (code & 0x1f). */
function ctrlChar(key: string): string | undefined {
	const code = key.charCodeAt(0);
	if ((code >= 97 && code <= 122) || key === "[" || key === "\\" || key === "]" || key === "_") {
		return String.fromCharCode(code & 0x1f);
	}
	if (key === "-") return "\x1f"; // same physical key as ctrl+_ on US layouts
	return undefined;
}

/**
 * Drop binding-map keys that are not valid key ids (typos, stray comments in
 * JSON). Returns a cleaned copy; warns about anything removed.
 */
function sanitizeBindings(bindings: { [key: string]: Binding }, path: string): { [key: string]: Binding } {
	const out: { [key: string]: Binding } = {};
	for (const [k, v] of Object.entries(bindings)) {
		if (!isValidKeyId(k)) {
			console.warn(`modal_keybinds: ignoring invalid key "${k}" at ${path}`);
			continue;
		}
		out[k] = isAction(v) ? v : sanitizeBindings(v, `${path} ${k}`);
	}
	return out;
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return isPlainObject(parsed) ? parsed : undefined;
	} catch (err) {
		console.error(`modal_keybinds: failed to parse ${path}:`, err);
		return undefined;
	}
}

/**
 * Load the modal configuration, merging three sources (later wins):
 *  1. built-in defaults,
 *  2. legacy `~/.pi/agent/modal_keybinds.json`,
 *  3. the `"modal"` block inside `~/.pi/agent/keybindings.json` (recommended).
 * Also returns the raw keybindings.json so reserved-key conflicts can be checked.
 */
function loadConfig(): { config: ModalConfig; userKeybindings: Record<string, unknown> } {
	const userKeybindings = readJsonFile(join(getAgentDir(), "keybindings.json")) ?? {};
	const kbBlock = isPlainObject(userKeybindings["modal"]) ? (userKeybindings["modal"] as ModalConfig) : {};
	const legacy = (readJsonFile(join(getAgentDir(), "modal_keybinds.json")) as ModalConfig | undefined) ?? {};

	const bindings = deepMerge(deepMerge(DEFAULT_CONFIG.bindings ?? {}, legacy.bindings ?? {}), kbBlock.bindings ?? {});
	// Omitted timeout_ms = no timeout (the modal waits for a key indefinitely).
	const timeout_ms =
		typeof kbBlock.timeout_ms === "number"
			? kbBlock.timeout_ms
			: typeof legacy.timeout_ms === "number"
				? legacy.timeout_ms
				: undefined;
	return { config: { timeout_ms, bindings }, userKeybindings };
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------
function validateConfig(bindings: { [prefix: string]: Binding }): boolean {
	let ok = true;
	const check = (b: Binding, path: string): void => {
		if (isAction(b)) {
			if (!KNOWN_ACTION_TYPES.has(b.type)) {
				console.warn(`modal_keybinds: unknown action type "${b.type}" at ${path}`);
				ok = false;
			}
			if (b.type === "handler" && typeof b.name !== "string") {
				console.warn(`modal_keybinds: handler action at ${path} is missing a "name"`);
				ok = false;
			}
			if (b.type === "key" && (typeof b.key !== "string" || !isValidKeyId(b.key))) {
				console.warn(`modal_keybinds: key action at ${path} needs a valid "key" (e.g. "ctrl+g")`);
				ok = false;
			}
			if (b.type === "action" && (typeof b.name !== "string" || b.name.length === 0)) {
				console.warn(`modal_keybinds: action at ${path} needs a "name" (e.g. "app.editor.external")`);
				ok = false;
			}
			return;
		}
		for (const [k, v] of Object.entries(b)) check(v, `${path} ${k}`);
	};
	for (const [prefix, sub] of Object.entries(bindings)) {
		if (!isBindingMap(sub)) {
			console.warn(`modal_keybinds: "${prefix}" must map second-level keys to bindings; got an action. Add a second key.`);
			ok = false;
			continue;
		}
		check(sub, prefix);
	}
	return ok;
}

// ---------------------------------------------------------------------------
// Modal state machine
// ---------------------------------------------------------------------------

const WIDGET_KEY = "modal_keybinds";
const STATUS_KEY = "modal_keybinds";

function enterModal(
	path: string[],
	bindings: { [key: string]: Binding },
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	tuiRef: TUI | undefined,
	timeoutMs?: number,
	onActiveChange: (close: (() => void) | undefined) => void,
): void {
	const seq = path.join(" → ");
	let closed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let unsub: (() => void) | undefined;

	const close = (timeoutNote?: string): void => {
		if (closed) return;
		closed = true;
		if (timer) clearTimeout(timer);
		unsub?.();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		onActiveChange(undefined);
		if (timeoutNote) ctx.ui.notify(timeoutNote, "info");
	};

	// --- render the menu widget + footer status -------------------------------
	const lines: string[] = [`modal keybinds — ${seq}`];
	for (const [keyId, binding] of Object.entries(bindings)) {
		lines.push(`  ${keyDisplay(keyId)}  ${describe(binding)}`);
	}
	lines.push("  esc  cancel");
	ctx.ui.setWidget(WIDGET_KEY, lines);
	ctx.ui.setStatus(STATUS_KEY, `awaiting ${seq} + key…`);
	onActiveChange(() => close());

	// --- wait for the next key -------------------------------------------------
	// A timeout_ms is optional — without one the modal stays open until the
	// next key, escape, or ctrl+c.
	if (timeoutMs !== undefined) {
		timer = setTimeout(() => close(`modal keybinds: ${seq} timed out`), timeoutMs);
	}

	unsub = ctx.ui.onTerminalInput((data) => {
		// With the kitty keyboard protocol (flag 2) pi reports key release and
		// repeat events. Releasing the prefix's modifier before its key (e.g.
		// `ctrl+x` → release ctrl → release x) would otherwise make the bare `x`
		// RELEASE false-match an "x" binding — so ignore releases/repeats and
		// only accept a genuine fresh press as the next key.
		if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
		// Cancel: escape / ctrl+c
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			close();
			return { consume: true };
		}
		// Match a second-level key
		for (const [keyId, binding] of Object.entries(bindings)) {
			if (matchesKey(data, keyId)) {
				close();
				if (isAction(binding)) {
					void executeAction(binding, path.concat(keyId), ctx, pi, tuiRef).catch((err: unknown) => {
						ctx.ui.notify(
							`modal_keybinds: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					});
				} else {
					enterModal(path.concat(keyId), binding, ctx, pi, tuiRef, timeoutMs, onActiveChange);
				}
				return { consume: true };
			}
		}
		// Unmatched key while waiting: consume so it doesn't leak into the editor.
		return { consume: true };
	});
}

async function executeAction(a: Action, seq: string[], ctx: ExtensionContext, pi: ExtensionAPI, tuiRef: TUI | undefined): Promise<void> {
	const label = `modal_keybinds ${seq.join(" ")}`;
	switch (a.type) {
		case "notify": {
			const message = typeof a.message === "string" ? a.message : "notify";
			ctx.ui.notify(`${label}: ${message}`, "info");
			return;
		}
		case "message": {
			const text = typeof a.text === "string" ? a.text : "";
			if (!text) {
				ctx.ui.notify(`${label}: missing "text"`, "error");
				return;
			}
			// followUp is safe both when idle (ignored) and when streaming (queued).
			await pi.sendUserMessage(text, { deliverAs: "followUp" });
			return;
		}
		case "editor": {
			ctx.ui.setEditorText(typeof a.text === "string" ? a.text : "");
			return;
		}
		case "editorAppend": {
			ctx.ui.setEditorText(ctx.ui.getEditorText() + (typeof a.text === "string" ? a.text : ""));
			return;
		}
		case "editorPrepend": {
			ctx.ui.setEditorText((typeof a.text === "string" ? a.text : "") + ctx.ui.getEditorText());
			return;
		}
		case "paste": {
			ctx.ui.pasteToEditor(typeof a.text === "string" ? a.text : "");
			return;
		}
		case "compact": {
			ctx.compact({
				onComplete: () => ctx.ui.notify("modal_keybinds: compaction complete", "info"),
				onError: (err) => ctx.ui.notify(`modal_keybinds: compaction failed: ${err.message}`, "error"),
			});
			return;
		}
		case "model": {
			await showNativeModelSelector(ctx, pi);
			return;
		}
		case "copy": {
			// Replicates pi's built-in `app.message.copy` (last assistant message).
			let text = "";
			const branch = ctx.sessionManager.getBranch();
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry?.type === "message" && entry.message?.role === "assistant") {
					text = messageText(entry.message);
					break;
				}
			}
			if (!text) {
				ctx.ui.notify(`${label}: no assistant message to copy`, "warning");
				return;
			}
			await copyToClipboard(text);
			ctx.ui.notify(`${label}: copied ${truncate(text, 40)}`, "info");
			return;
		}
		case "key": {
			const keyId = typeof a.key === "string" ? a.key : "";
			if (!keyId || !isValidKeyId(keyId)) {
				ctx.ui.notify(`${label}: "key" needs a valid key id (e.g. "ctrl+g")`, "error");
				return;
			}
			if (!tuiRef) {
				ctx.ui.notify(`${label}: TUI not ready yet`, "error");
				return;
			}
			const raw = keyIdToRaw(keyId);
			if (raw === undefined) {
				ctx.ui.notify(`${label}: cannot replay "${keyId}"`, "error");
				return;
			}
			// Replay the keypress through pi's own input pipeline (input listeners
			// → focused component). The focused editor's keybinding matching then
			// dispatches the bound app action, so pi's existing handler runs
			// exactly as if the user had pressed the key — e.g. ctrl+g →
			// app.editor.external (pi's native external editor flow).
			tuiRef.handleInput(raw);
			return;
		}
		case "action": {
			const name = typeof a.name === "string" ? a.name : "";
			if (!name) {
				ctx.ui.notify(`${label}: "action" needs a "name" (e.g. "app.editor.external")`, "error");
				return;
			}
			if (!tuiRef) {
				ctx.ui.notify(`${label}: TUI not ready yet`, "error");
				return;
			}
			const editor = tuiRef.focusedComponent;
			if (!(editor instanceof CustomEditor) || !editor.actionHandlers.has(name)) {
				ctx.ui.notify(`${label}: no action "${name}" registered on the focused editor`, "error");
				return;
			}
			// Call pi's registered handler for the app action directly — the very
			// same handler keybinding dispatch would run, without any keybinding
			// lookup. Rebinding or unbinding the action's key has no effect here.
			editor.actionHandlers.get(name)!();
			return;
		}
		case "handler": {
			const name = typeof a.name === "string" ? a.name : "";
			// Local handler, or cross-extension dispatch on pi.events.
			const local = handlers[name];
			if (local) {
				await local(ctx, pi);
				return;
			}
			if (name.includes(":")) {
				pi.events.emit(name, { ctx, pi });
				return;
			}
			ctx.ui.notify(`${label}: unknown handler "${name}"`, "error");
			return;
		}
		default:
			ctx.ui.notify(`${label}: unknown action type "${a.type}"`, "error");
	}
}

/**
 * Open pi's native model selector — the exact same component `/model` opens.
 * Uses `ctx.ui.custom()`, which swaps the editor for the selector and restores
 * the editor *with its text* when the selector closes, so anything typed before
 * `ctrl+x` `m` is preserved.
 */
async function showNativeModelSelector(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	// The component persists the chosen default via settingsManager; pi.setModel()
	// already does that (auth check, session change, persistence), so a no-op
	// stub is safe here.
	const settingsManager = {
		setDefaultModelAndProvider: () => {},
	} as unknown as SettingsManager;
	// Thin adapter: the component expects a ModelRuntime, extensions only get the
	// synchronous ModelRegistry facade.
	const modelRuntime = {
		getAvailableSnapshot: () => ctx.modelRegistry.getAll(),
		getModel: (provider: string, id: string) => ctx.modelRegistry.find(provider, id),
		refresh: async (_opts?: { signal?: AbortSignal }) => {
			await ctx.modelRegistry.refresh();
			return { aborted: false, errors: new Map() };
		},
		getError: () => ctx.modelRegistry.getError(),
	} as unknown as ModelRuntime;

	await ctx.ui.custom<unknown>((tui, _theme, _keybindings, done) => {
		const selector = new ModelSelectorComponent(
			tui,
			ctx.model,
			settingsManager,
			modelRuntime,
			ctx.scopedModels,
			async (model) => {
				try {
					await pi.setModel(model);
					done(undefined);
				} catch (err) {
					done(undefined);
					ctx.ui.notify(
						`modal_keybinds: ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
				}
			},
			() => done(undefined),
		);
		return selector;
	});
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	const { config } = loadConfig();
	// Drop invalid keys (typos, stray JSON comments) before registering.
	const bindings = sanitizeBindings(config.bindings ?? {}, "<root>");
	const timeoutMs = config.timeout_ms; // undefined = no timeout

	if (!validateConfig(bindings)) {
		console.warn("modal_keybinds: config has errors; loading valid prefixes only.");
	}

	// Track the currently active modal so we can cancel it on shutdown/reload.
	let activeClose: (() => void) | undefined;
	const setActive = (close: (() => void) | undefined): void => {
		activeClose = close;
	};

	// The TUI is captured lazily from an (invisible) widget factory — an empty
	// Text renders zero lines. It is used to check which component has focus.
	let tuiRef: TUI | undefined;

	// The single TUI-level input listener that owns every prefix key.
	//
	// It replaces `pi.registerShortcut`: because no shortcut is registered, pi
	// has nothing to flag in its conflict check, so no "Extension shortcut
	// conflict" warning appears at startup. And because prefixes only fire while
	// the input editor is focused, keys keep their native meaning anywhere else
	// (e.g. `/scoped-models` keeps its own `ctrl+x` "clear").
	let currentCtx: ExtensionContext | undefined;
	let outerUnsub: (() => void) | undefined;
	const teardownOuter = (): void => {
		outerUnsub?.();
		outerUnsub = undefined;
		currentCtx = undefined;
	};

	const onGlobalInput = (data: string) => {
		try {
			// While a modal is waiting, the inner listener registered by
			// enterModal owns every key — pass everything to it without
			// consuming, including releases/repeats (it filters those itself).
			if (activeClose) return { consume: false };
			// Key release/repeat events can never start a modal; let them be.
			if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: false };
			// Only intercept prefix presses while the input editor is focused.
			if (!(tuiRef?.focusedComponent instanceof Editor)) return { consume: false };
			for (const [prefixKey, subBindings] of Object.entries(bindings)) {
				if (!isBindingMap(subBindings)) continue; // already warned in validateConfig
				if (matchesKey(data, prefixKey) && currentCtx) {
					enterModal([prefixKey], subBindings, currentCtx, pi, tuiRef, timeoutMs, setActive);
					return { consume: true };
				}
			}
			return { consume: false };
		} catch {
			// Never break terminal input: let the key through on any error.
			return { consume: false };
		}
	};

	// The listener holds the ctx of the session that registered it; contexts go
	// stale when the session is replaced, so (re)register it per session.
	pi.on("session_shutdown", () => {
		activeClose?.();
		setActive(undefined);
		teardownOuter();
	});

	pi.on("session_start", (_event, ctx) => {
		teardownOuter(); // replace the previous session's listener
		currentCtx = ctx;
		ctx.ui.setWidget("modal_keybinds_tui", (tui) => {
			tuiRef = tui;
			return new Text("");
		});
		outerUnsub = ctx.ui.onTerminalInput(onGlobalInput);
	});

	// Discoverability: `/modal_keybinds` prints the current configuration.
	pi.registerCommand("modal_keybinds", {
		description: "List configured modal keybindings",
		handler: (_args, ctx) => {
			const lines: string[] = ["config: keybindings.json → \"modal\" (legacy: modal_keybinds.json)"];
			for (const [prefix, sub] of Object.entries(bindings)) {
				const keys = isBindingMap(sub) ? Object.keys(sub) : [];
				lines.push(`${prefix} → ${keys.map(keyDisplay).join(" ")}`);
			}
			ctx.ui.notify(lines.length ? lines.join("\n") : "no modal keybindings configured", "info");
		},
	});
}
