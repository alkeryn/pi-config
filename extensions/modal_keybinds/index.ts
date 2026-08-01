/**
 * modal_keybinds — modal (multi-key) keybindings for pi.
 *
 * Lets you bind key *sequences* like `ctrl+x` then `l` to actions, similar to
 * emacs key chords or vim leader keys. Any depth is supported (`alt+x` `g` `b`).
 *
 * Configuration lives in `~/.pi/agent/modal_keybinds.json` (global). The file
 * is deep-merged over the defaults below, so you only need to list what you
 * want to change. See modal_keybinds.example.json and README.md in this folder.
 *
 * How it works:
 *  - A shortcut is registered for every first-level prefix key (e.g. `ctrl+x`).
 *  - When the prefix fires, a small menu widget is shown above the editor and a
 *    terminal input listener grabs the *next* key. `matchesKey` from pi-tui is
 *    used to match the raw input against configured key ids.
 *  - On a match the action executes (or the chain descends one level), on
 *    `escape`/`ctrl+c` the sequence is cancelled, and a timeout auto-cancels.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
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
	timeoutMs?: number;
	/** prefix keyId → map of second-level keyId → binding. */
	bindings?: { [prefix: string]: Binding };
}

/** Custom JS handlers, referenced from config via `{ "type": "handler", "name": "..." }`. */
export type CustomHandler = (ctx: ExtensionContext, pi: ExtensionAPI) => void | Promise<void>;

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
	timeoutMs: 5000,
	bindings: {
		// Default prefixes use keys with no built-in binding (`alt+x`, `alt+g`)
		// so they work out of the box. pi reserves several built-in keys
		// (`app.message.copy` = ctrl+x, `app.editor.external` = ctrl+g, …) and
		// silently skips extension shortcuts that collide with them unless you
		// rebind the built-in first — see README.md "Reserved keys".
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
			return "pick a model";
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

function loadConfig(): ModalConfig {
	let fileConfig: ModalConfig = {};
	const file = join(getAgentDir(), "modal_keybinds.json");
	if (existsSync(file)) {
		try {
			fileConfig = JSON.parse(readFileSync(file, "utf8")) as ModalConfig;
		} catch (err) {
			console.error(`modal_keybinds: failed to parse ${file}:`, err);
		}
	}
	const bindings = deepMerge(DEFAULT_CONFIG.bindings ?? {}, fileConfig.bindings ?? {});
	return {
		timeoutMs: typeof fileConfig.timeoutMs === "number" ? fileConfig.timeoutMs : DEFAULT_CONFIG.timeoutMs,
		bindings,
	};
}

/** Validate the config shape; warn on issues. Returns true when valid. */
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
	timeoutMs: number,
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
	timer = setTimeout(() => close(`modal keybinds: ${seq} timed out`), timeoutMs);

	unsub = ctx.ui.onTerminalInput((data) => {
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
					void executeAction(binding, path.concat(keyId), ctx, pi).catch((err: unknown) => {
						ctx.ui.notify(
							`modal_keybinds: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					});
				} else {
					enterModal(path.concat(keyId), binding, ctx, pi, timeoutMs, onActiveChange);
				}
				return { consume: true };
			}
		}
		// Unmatched key while waiting: consume so it doesn't leak into the editor.
		return { consume: true };
	});
}

async function executeAction(a: Action, seq: string[], ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
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
			await pickModel(ctx, pi);
			return;
		}
		case "handler": {
			const name = typeof a.name === "string" ? a.name : "";
			const handler = handlers[name];
			if (!handler) {
				ctx.ui.notify(`${label}: unknown handler "${name}"`, "error");
				return;
			}
			await handler(ctx, pi);
			return;
		}
		default:
			ctx.ui.notify(`${label}: unknown action type "${a.type}"`, "error");
	}
}

async function pickModel(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	const models = ctx.modelRegistry.getAvailable();
	if (models.length === 0) {
		ctx.ui.notify("modal_keybinds: no models available", "warning");
		return;
	}
	const current = ctx.model;
	const labels = models.map((m) => {
		const name = typeof m.name === "string" ? m.name : m.id;
		const suffix = m.id === current?.id && m.provider === current.provider ? " ✓" : "";
		return `${name} (${m.provider}/${m.id})${suffix}`;
	});
	const choice = await ctx.ui.select("Switch model:", labels);
	if (!choice) return;
	const idx = labels.indexOf(choice);
	if (idx === -1) return;
	const ok = await pi.setModel(models[idx]!);
	if (!ok) ctx.ui.notify("modal_keybinds: could not switch model (missing API key?)", "error");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	const config = loadConfig();
	// Drop invalid keys (typos, stray JSON comments) before registering.
	const bindings = sanitizeBindings(config.bindings ?? {}, "<root>");
	const timeoutMs = config.timeoutMs ?? 5000;

	if (!validateConfig(bindings)) {
		console.warn("modal_keybinds: config has errors; loading valid prefixes only.");
	}

	// Track the currently active modal so we can cancel it on shutdown/reload.
	let activeClose: (() => void) | undefined;
	const setActive = (close: (() => void) | undefined): void => {
		activeClose = close;
	};

	pi.on("session_shutdown", () => {
		activeClose?.();
		setActive(undefined);
	});

	for (const [prefixKey, subBindings] of Object.entries(bindings)) {
		if (!isBindingMap(subBindings)) continue; // already warned in validateConfig
		pi.registerShortcut(prefixKey, {
			description: `modal_keybinds: ${prefixKey} prefix (${Object.keys(subBindings).length} bindings)`,
			handler: (ctx) => {
				if (ctx.mode !== "tui" || !ctx.hasUI) {
					ctx.ui.notify(`modal_keybinds: ${prefixKey} requires TUI mode`, "warning");
					return;
				}
				enterModal([prefixKey], subBindings, ctx, pi, timeoutMs, setActive);
			},
		});
	}

	// Discoverability: `/modal_keybinds` prints the current configuration.
	pi.registerCommand("modal_keybinds", {
		description: "List configured modal keybindings",
		handler: (_args, ctx) => {
			const lines: string[] = [];
			for (const [prefix, sub] of Object.entries(bindings)) {
				const keys = isBindingMap(sub) ? Object.keys(sub) : [];
				lines.push(`${prefix} → ${keys.map(keyDisplay).join(" ")}`);
			}
			ctx.ui.notify(lines.length ? lines.join("\n") : "no modal keybindings configured", "info");
		},
	});
}
