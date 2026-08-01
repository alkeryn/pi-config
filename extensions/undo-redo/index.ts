/**
 * undo-redo — undo/redo the last user message in the session tree.
 *
 * Commands:
 *   /undo — same as selecting the last user message in /tree with no summary:
 *           the session leaf moves back to before that message and the message
 *           text is restored into the editor so you can re-edit/re-send it.
 *   /redo — restores the leaf that was active before the last /undo.
 *
 * Cross-extension bridge:
 *   Registers `undo` and `redo` in the shared external-handler registry
 *   (globalThis.__piExtensionHandlers — the same registry modal_keybinds reads
 *   for `{ "type": "handler", "name": "…" }` actions), so keybindings.json can
 *   bind them:
 *
 *     { "modal": { "bindings": { "ctrl+x": {
 *         "u": { "type": "handler", "name": "undo", "label": "Undo last message" },
 *         "r": { "type": "handler", "name": "redo", "label": "Redo last message" }
 *     } } } }
 *
 * Command-only privilege note: session tree navigation (ctx.navigateTree) is
 * only available in command contexts. When these handlers are invoked from a
 * plain ExtensionContext (modal keybind), the /undo or /redo command is run
 * through the editor submit path (prefill + synthetic Enter) — the exact same
 * code path as typing the command, so the session and UI stay fully in sync.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Shared cross-extension handler registry (also read by modal_keybinds)
// ---------------------------------------------------------------------------

export type ExternalHandler = (ctx: ExtensionContext, pi: ExtensionAPI) => void | Promise<void>;

/** Well-known global registry: modal_keybinds resolves `handler` names here. */
function getExternalRegistry(): Record<string, ExternalHandler> {
	const g = globalThis as { __piExtensionHandlers?: Record<string, ExternalHandler> };
	if (!g.__piExtensionHandlers) {
		g.__piExtensionHandlers = {};
	}
	return g.__piExtensionHandlers;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	// Leaf ids that can be restored via /redo, most recent first.
	let redoStack: string[] = [];
	// TUI reference for the editor-submit bridge (captured from an invisible widget).
	let tuiRef: TUI | undefined;

	pi.on("session_start", (_event, ctx) => {
		redoStack = [];
		tuiRef = undefined;
		ctx.ui.setWidget("undo_redo_tui", (tui) => {
			tuiRef = tui;
			return new Text("");
		});
	});

	// A new turn means the conversation diverged from the undo point — redo
	// must not resurrect the abandoned branch.
	pi.on("agent_start", () => {
		redoStack = [];
	});

	/** Last user message on the current branch, or undefined. */
	function findLastUserMessageId(ctx: ExtensionContext): string | undefined {
		const branch = ctx.sessionManager.getBranch(); // root → leaf
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry?.type === "message" && entry.message.role === "user") {
				return entry.id;
			}
		}
		return undefined;
	}

	async function doUndo(ctx: ExtensionCommandContext): Promise<void> {
		const userMessageId = findLastUserMessageId(ctx);
		if (!userMessageId) {
			ctx.ui.notify("undo: no user message to undo", "warning");
			return;
		}
		const leafId = ctx.sessionManager.getLeafId();
		// Remember the current leaf so /redo can come back. Skipped when the
		// leaf already is the user message (aborted turn): redo can't land on a
		// user message (navigateTree moves to its parent, like /tree).
		if (leafId && leafId !== userMessageId) {
			redoStack.push(leafId);
		}
		// Identical to selecting the last user message in /tree without a summary.
		await ctx.navigateTree(userMessageId, { summarize: false });
		ctx.ui.notify("undo: reverted to last user message", "info");
	}

	async function doRedo(ctx: ExtensionCommandContext): Promise<void> {
		const target = redoStack.pop();
		if (!target) {
			ctx.ui.notify("redo: nothing to redo", "warning");
			return;
		}
		const entry = ctx.sessionManager.getEntry(target);
		if (!entry || entry.type !== "message") {
			ctx.ui.notify("redo: target entry is no longer available", "warning");
			return;
		}
		if (entry.message.role === "user") {
			ctx.ui.notify("redo: nothing to redo (leaf was a user message)", "warning");
			return;
		}
		await ctx.navigateTree(target, { summarize: false });
		ctx.ui.notify("redo: restored", "info");
	}

	// Commands: the fully-privileged entry points (typed as /undo, /redo).
	pi.registerCommand("undo", {
		description: "Undo the last message (same as selecting the last user message in /tree without a summary)",
		handler: async (_args, ctx) => {
			await doUndo(ctx);
		},
	});
	pi.registerCommand("redo", {
		description: "Redo the last undone message",
		handler: async (_args, ctx) => {
			await doRedo(ctx);
		},
	});

	/** Bridge for plain ExtensionContexts: run the command via the editor submit path. */
	function runViaEditor(ctx: ExtensionContext, command: "undo" | "redo"): void {
		if (ctx.ui.getEditorText().trim()) {
			ctx.ui.notify(`undo-redo: editor not empty — clear it or run /${command} manually`, "warning");
			return;
		}
		if (!tuiRef) {
			ctx.ui.notify("undo-redo: TUI not ready yet", "error");
			return;
		}
		ctx.ui.setEditorText(`/${command}`);
		// Submits the editor: same path as typing /undo + Enter. The editor
		// clears itself before onSubmit() runs, so the command handler's
		// editor-text restoration still applies.
		tuiRef.handleInput("\r");
	}

	async function handleExternal(ctx: ExtensionContext, pi: ExtensionAPI, fn: "undo" | "redo"): Promise<void> {
		const commandCtx = ctx as Partial<ExtensionCommandContext>;
		if (typeof commandCtx.navigateTree === "function") {
			// Already a command context (e.g. invoked from another command).
			if (fn === "undo") await doUndo(commandCtx as ExtensionCommandContext);
			else await doRedo(commandCtx as ExtensionCommandContext);
			return;
		}
		// Plain ExtensionContext (modal keybind): bridge through the editor.
		runViaEditor(ctx, fn);
	}

	// Expose to other extensions (modal_keybinds) under the well-known names.
	const registry = getExternalRegistry();
	registry.undo = (ctx, pi) => handleExternal(ctx, pi, "undo");
	registry.redo = (ctx, pi) => handleExternal(ctx, pi, "redo");
}
