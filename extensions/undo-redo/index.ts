/**
 * undo-redo — undo/redo the last user message in the session tree.
 *
 * Commands:
 *   /undo — same as selecting the last user message in /tree with no summary:
 *           the session leaf moves back to before that message and the message
 *           text is restored into the editor so you can re-edit/re-send it.
 *   /redo — restores the leaf that was active before the last /undo.
 *
 * Aborted turns: if the leaf is itself the last user message (the turn ended
 * before any assistant message was persisted), /undo still moves the leaf back
 * to before that message and restores its text — it does not no-op.
 *
 * Redo targets are any leaf that can be landed on via navigateTree: assistant
 * messages, tool results, compaction and branch_summary entries. Only user /
 * custom messages are excluded (navigateTree moves to their parent, like /tree).
 *
 * Cross-extension bridge:
 *   Subscribes to the shared event bus channels `"undo-redo:undo"` and
 *   `"undo-redo:redo"` (pi.events — the documented "Shared event bus for
 *   extension communication"), so keybindings.json can bind them via
 *   modal_keybinds' generic `handler` action — the name is the channel:
 *
 *     { "modal": { "bindings": { "ctrl+x": {
 *         "u": { "type": "handler", "name": "undo-redo:undo", "label": "Undo last message" },
 *         "r": { "type": "handler", "name": "undo-redo:redo", "label": "Redo last message" }
 *     } } } }
 *
 * modal_keybinds does not know this extension exists — it just emits `{ ctx, pi }`
 * on the channel named in the config.
 *
 * Command-only privilege note: session tree navigation (ctx.navigateTree) is
 * only available in command contexts. When these handlers are invoked from a
 * plain ExtensionContext (modal keybind), the /undo or /redo command is run
 * through the editor submit path (prefill + synthetic Enter) — the exact same
 * code path as typing the command, so the session and UI stay fully in sync.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Subscribed event channels (pi.events). The names double as the `handler`
 * names used in keybindings.json (e.g. `undo-redo:undo`).
 */
export type UndoRedoEvents = {
	"undo-redo:undo": { ctx: ExtensionContext; pi: ExtensionAPI };
	"undo-redo:redo": { ctx: ExtensionContext; pi: ExtensionAPI };
};

export default function (pi: ExtensionAPI): void {
	// Leaf ids that can be restored via /redo, most recent first.
	let redoStack: string[] = [];
	// TUI reference for the editor-submit bridge (captured from an invisible widget).
	let tuiRef: TUI | undefined;
	// True while this extension performs its own tree navigation (undo/redo),
	// so the session_tree handler knows not to clear the stack it just updated.
	let navigating = false;

	pi.on("session_start", (_event, ctx) => {
		redoStack = [];
		navigating = false;
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

	// A manual tree navigation (/tree) also diverges from the undo point — redo
	// must not resurrect a branch the user navigated away from. Our own
	// undo/redo navigations set `navigating` and are excluded.
	pi.on("session_tree", () => {
		if (!navigating) {
			redoStack = [];
		}
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

	/** Plain text of a message (string content or text blocks), for editor restore. */
	function messageText(content: string | { type: string; text?: string }[]): string {
		if (typeof content === "string") return content;
		return content.map((block) => (block.type === "text" ? block.text ?? "" : "")).join("");
	}

	type NavigateOptions = Parameters<ExtensionCommandContext["navigateTree"]>[1];
	type NavigateResult = Awaited<ReturnType<ExtensionCommandContext["navigateTree"]>>;

	/** ctx.navigateTree with the `navigating` flag set so session_tree keeps the stack. */
	async function navigate(ctx: ExtensionCommandContext, targetId: string, options?: NavigateOptions): Promise<NavigateResult> {
		navigating = true;
		try {
			return await ctx.navigateTree(targetId, options);
		} finally {
			navigating = false;
		}
	}

	// ctx.sessionManager is typed as a readonly view; the runtime object is a
	// full SessionManager, so casting is safe for the one mutation we need.
	function resetToRoot(ctx: ExtensionCommandContext): void {
		(ctx.sessionManager as SessionManager).resetLeaf();
	}

	async function doUndo(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.isIdle()) {
			// navigateTree throws while a turn is running; surface a clean notice
			// instead of an error (the modal bridge would otherwise fail silently).
			ctx.ui.notify("undo: wait for the current response to finish first", "warning");
			return;
		}
		const userMessageId = findLastUserMessageId(ctx);
		if (!userMessageId) {
			ctx.ui.notify("undo: no user message to undo", "warning");
			return;
		}
		const leafId = ctx.sessionManager.getLeafId();
		const userEntry = ctx.sessionManager.getEntry(userMessageId);
		if (!userEntry || userEntry.type !== "message" || userEntry.message.role !== "user") {
			ctx.ui.notify("undo: last user message is missing", "warning");
			return;
		}
		// Remember the current leaf so /redo can come back. Skipped when the
		// leaf already IS the user message (aborted turn): redo can't land on a
		// user message (navigateTree moves to its parent, like /tree).
		if (leafId && leafId !== userMessageId) {
			redoStack.push(leafId);
		}
		if (leafId === userMessageId) {
			// Aborted turn: navigateTree(userMessageId) would no-op because
			// targetId === oldLeafId, so move to the message's parent explicitly
			// and restore its text into the editor (the interactive wrapper only
			// restores text for user-message targets).
			const editorText = messageText(userEntry.message.content);
			if (userEntry.parentId !== null) {
				await navigate(ctx, userEntry.parentId, { summarize: false });
			} else {
				// First message in the session: nothing before it — reset to root.
				// (No entry id exists to navigate to; the chat area only re-renders
				// on the next interaction.)
				resetToRoot(ctx);
			}
			ctx.ui.setEditorText(editorText);
			ctx.ui.notify("undo: reverted to last user message", "info");
			return;
		}
		// Identical to selecting the last user message in /tree without a summary.
		await navigate(ctx, userMessageId, { summarize: false });
		ctx.ui.notify("undo: reverted to last user message", "info");
	}

	async function doRedo(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.isIdle()) {
			ctx.ui.notify("redo: wait for the current response to finish first", "warning");
			return;
		}
		const target = redoStack.pop();
		if (!target) {
			ctx.ui.notify("redo: nothing to redo", "warning");
			return;
		}
		const entry = ctx.sessionManager.getEntry(target);
		if (!entry) {
			ctx.ui.notify("redo: target entry is no longer available", "warning");
			return;
		}
		// navigateTree lands on the target itself for everything except user and
		// custom messages (those move to their parent, like /tree), so such
		// leaves cannot be restored via redo. Compaction / branch_summary / tool
		// result leaves are fine and are restored normally.
		if (entry.type === "custom_message" || (entry.type === "message" && entry.message.role === "user")) {
			ctx.ui.notify("redo: nothing to redo (target cannot be a leaf)", "warning");
			return;
		}
		await navigate(ctx, target, { summarize: false });
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
		if (!tuiRef) {
			ctx.ui.notify("undo-redo: TUI not ready yet", "error");
			return;
		}
		if (!ctx.isIdle()) {
			// Replaying Enter while a turn is running would run /undo or /redo,
			// whose navigateTree throws — the fire-and-forget event bus would
			// swallow it. Check first and tell the user to wait.
			ctx.ui.notify("undo-redo: wait for the current response to finish first", "warning");
			return;
		}
		// setEditorText discards whatever is currently in the editor — the draft
		// is intentionally dropped (undo/redo always win over pending input).
		ctx.ui.setEditorText(`/${command}`);
		// Submits the editor: same path as typing /undo + Enter. The editor
		// clears itself before onSubmit() runs, so the command handler's
		// editor-text restoration still applies.
		// TUI.handleInput is private in the typings but present at runtime.
		(tuiRef as unknown as { handleInput(data: string): void }).handleInput("\r");
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

	// Subscribe to the shared event bus so modal_keybinds' generic `handler`
	// action can reach us: channels "undo-redo:undo" / "undo-redo:redo".
	pi.events.on("undo-redo:undo", async (data) => {
		const { ctx, pi: piArg } = data as UndoRedoEvents["undo-redo:undo"];
		await handleExternal(ctx, piArg, "undo");
	});
	pi.events.on("undo-redo:redo", async (data) => {
		const { ctx, pi: piArg } = data as UndoRedoEvents["undo-redo:redo"];
		await handleExternal(ctx, piArg, "redo");
	});
}
