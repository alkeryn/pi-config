/**
 * pin-bottom — keep the text input and footer pinned to the bottom of the
 * terminal.
 *
 * By default pi renders the chat content, the input editor, and the footer as
 * one buffer stacked from the top. When the chat is shorter than the terminal
 * height, the input and footer sit right under the last message instead of at
 * the bottom of the screen. This extension inserts blank filler lines between
 * the chat content and the editor so the input + footer always end exactly on
 * the bottom row of the terminal (when the content is long enough to fill the
 * screen, nothing changes — pi's viewport already keeps the bottom bar
 * visible).
 *
 * Install:
 *   Drop this directory into ~/.config/pi/extensions/  (global)
 *   or .pi/extensions/  (project-local), then run /reload or restart pi.
 * Remove the directory to restore the default layout.
 */

import { TUI } from "@earendil-works/pi-tui";

let patched = false;

/**
 * Wrap the TUI's render() so that, when the rendered buffer is shorter than
 * the terminal, blank lines are inserted right before the editor container.
 * This pushes the input editor and the footer down to the bottom row.
 *
 * The replacement renders each top-level child exactly once (matching the
 * original Container.render loop), so there is no double-rendering cost.
 */
function patchTuiRender(): void {
	if (patched) return;
	patched = true;

	const proto = TUI.prototype as unknown as {
		render(width: number): string[];
	};

	proto.render = function (this: TUI, width: number): string[] {
		// Render every top-level child once, keeping per-child output so we can
		// splice filler lines in without re-rendering anything.
		const children = (this as any).children as any[];
		if (!Array.isArray(children)) return proto.render.call(this, width);

		const parts: string[][] = [];
		for (const child of children) {
			parts.push(child.render(width));
		}
		const total = parts.reduce((sum, part) => sum + part.length, 0);

		const height = (this as any).terminal?.rows;
		const editorIndex = findEditorContainerIndex(children, (this as any).focusedComponent);
		const shortage = typeof height === "number" && height > 0 ? height - total : 0;

		if (shortage <= 0 || editorIndex === -1) {
			// Nothing to pad (content fills the screen, or we're not looking at
			// the main chat layout) — identical to the original render.
			const flat: string[] = [];
			for (const part of parts) {
				for (const line of part) flat.push(line);
			}
			return flat;
		}

		const out: string[] = [];
		for (let i = 0; i < parts.length; i++) {
			if (i === editorIndex) {
				for (let p = 0; p < shortage; p++) out.push("");
			}
			for (const line of parts[i]) out.push(line);
		}
		return out;
	};
}

/**
 * Find the top-level child that holds the input editor — i.e. where the
 * "bottom bar" (editor + below-editor widgets + footer) begins.
 *
 * The editor container always directly contains the focused component while it
 * owns input (the editor, an extension selector, an extension input, ...).
 * Fallbacks cover the brief moments focus lives elsewhere (e.g. overlays).
 */
function findEditorContainerIndex(children: any[], focused: any): number {
	// 1) The container that directly holds the focused component.
	for (let i = 0; i < children.length; i++) {
		const sub = children[i]?.children;
		if (Array.isArray(sub) && sub.includes(focused)) return i;
	}
	// 2) A container holding an editor / input / selector component.
	for (let i = 0; i < children.length; i++) {
		const sub = children[i]?.children;
		if (!Array.isArray(sub) || sub.length === 0) continue;
		const names = sub.map((c: any) => c?.constructor?.name ?? "");
		if (names.some((name: string) => /(Editor|Input|Selector)$/.test(name))) return i;
	}
	// 3) Fallback: the bottom bar is the last three children
	//    [editorContainer, belowEditorWidgets, footer].
	if (children.length >= 3) return children.length - 3;
	return -1;
}

export default function (pi: unknown): void {
	// Patch as early as possible (module load) so even the first frame is pinned.
	void pi;
	patchTuiRender();
}
