/**
 * session-actions — run pi's native session-management commands from modal keybinds.
 *
 * Bridges the shared event bus channels `"session-actions:new"` and
 * `"session-actions:resume"` (pi.events — the documented "Shared event bus for
 * extension communication") to pi's native `/new` and `/resume` flows, so
 * keybindings.json can bind them via modal_keybinds' generic `handler` action —
 * the name is the channel:
 *
 *   { "modal": { "bindings": { "ctrl+x": {
 *       "n": { "type": "handler", "name": "session-actions:new",    "label": "New session" },
 *       "l": { "type": "handler", "name": "session-actions:resume", "label": "Resume session" }
 *   } } } }
 *
 * modal_keybinds does not know this extension exists — it just emits `{ ctx, pi }`
 * on the channel named in the config.
 *
 * Editor-bridge note: `/new` and `/resume` are handled by interactive-mode's
 * input handler, not by extension commands, and there is no programmatic entry
 * point for them from a plain ExtensionContext. They are run through the
 * editor submit path (prefill + synthetic Enter) — the exact same code path as
 * typing the command — so pi's native flows (new-session confirmation, the
 * session picker for resume) and the session/UI lifecycle stay fully in sync.
 * Like undo-redo, the current editor draft is intentionally discarded.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Subscribed event channels (pi.events). The names double as the `handler`
 * names used in keybindings.json (e.g. `session-actions:new`).
 */
export type SessionActionsEvents = {
	"session-actions:new": { ctx: ExtensionContext; pi: ExtensionAPI };
	"session-actions:resume": { ctx: ExtensionContext; pi: ExtensionAPI };
};

export default function (pi: ExtensionAPI): void {
	// TUI reference for the editor-submit bridge (captured from an invisible widget).
	let tuiRef: TUI | undefined;

	pi.on("session_start", (_event, ctx) => {
		tuiRef = undefined;
		ctx.ui.setWidget("session_actions_tui", (tui) => {
			tuiRef = tui;
			return new Text("");
		});
	});

	/** Bridge for plain ExtensionContexts: run a native command via the editor submit path. */
	function runViaEditor(ctx: ExtensionContext, command: "/new" | "/resume"): void {
		if (!tuiRef) {
			ctx.ui.notify("session-actions: TUI not ready yet", "error");
			return;
		}
		// setEditorText discards whatever is currently in the editor — the draft
		// is intentionally dropped (the command always wins over pending input).
		ctx.ui.setEditorText(command);
		// Submits the editor: same path as typing the command + Enter.
		tuiRef.handleInput("\r");
	}

	// Subscribe to the shared event bus so modal_keybinds' generic `handler`
	// action can reach us: channels "session-actions:new" / "session-actions:resume".
	pi.events.on("session-actions:new", (data) => {
		const { ctx } = data as SessionActionsEvents["session-actions:new"];
		runViaEditor(ctx, "/new");
	});
	pi.events.on("session-actions:resume", (data) => {
		const { ctx } = data as SessionActionsEvents["session-actions:resume"];
		runViaEditor(ctx, "/resume");
	});
}
