/**
 * Resume aborted responses + send aborted messages to the model (pi extension)
 *
 * Two related behaviors:
 *
 * 1. **Send aborted messages (default ON, setting `send_aborted_message`).**
 *    pi's provider layer (`transformMessages`) silently drops assistant
 *    messages whose `stopReason` is `"aborted"`, so after you abort a reply the
 *    model has no idea what it was writing — typing "continue" starts a fresh
 *    answer. With this extension, text-bearing aborted assistant messages are
 *    re-included in the context sent to the model (incomplete toolCall blocks
 *    stripped, stop reason neutralized), so the model continues from where it
 *    was cut off.
 *
 *    Setting: `"send_aborted_message": true` in `~/.pi/agent/settings.json`
 *    (default when absent: **true**). Toggle with `/send-aborted` or
 *    `/send-aborted on|off`.
 *
 * 2. **Continue on empty Enter.** When the editor is EMPTY and Enter (the
 *    submit key) is pressed while the last assistant message was aborted (and
 *    has streamed text), this extension resumes that response: the partial
 *    assistant message is kept as the final context item sent to the LLM,
 *    which then continues writing from where it was cut off — mirroring the
 *    "Continue Response" button in Open WebUI. Requires `send_aborted_message`
 *    to be enabled (it is by default).
 *
 * Mechanism:
 *   1. A CustomEditor wraps the default editor and intercepts the submit key on
 *      an empty editor.
 *   2. If the last assistant message was aborted (and has text), it injects an
 *      invisible custom marker message and triggers a new agent turn.
 *   3. The `context` extension event removes the marker (always) and makes
 *      aborted assistant messages sendable (when the setting is on), so the
 *      provider sees [history…, assistant: "<partial text>"] as context and
 *      continues the partial text.
 *
 * The continuation appears as a new assistant message following the aborted one.
 *
 * Usage:
 *   pi --extension ./index.ts
 *   (or copy this folder into ~/.pi/agent/extensions/)
 */

import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** customType of the invisible marker message that triggers the continuation turn. */
const MARKER_TYPE = "pi-resume-marker";

/**
 * Fallback content carried by the marker. In normal operation the `context`
 * transform removes the marker before the provider call, so NO user message is
 * ever sent to the LLM. This text only matters if that transform fails
 * (extension error): the model would then see a short "Continue" user message
 * instead of nothing, which still points it at the partial assistant text.
 */
const MARKER_FALLBACK_TEXT = "Continue";

/**
 * settings.json key controlling behavior (1): send aborted assistant messages
 * to the model. Default true when the key is absent.
 */
const SETTINGS_KEY = "send_aborted_message";
const SETTINGS_DEFAULT = true;

interface ContentBlock {
    type: string;
    text?: string;
    thinking?: string;
    [key: string]: unknown;
}

interface AssistantMessageLike {
    role: string;
    stopReason?: string;
    content?: ContentBlock[];
    [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Settings helpers (pi exposes no settings API to extensions; read/write the
// settings.json file directly, preserving all other keys — pi itself merges
// unknown keys back when it saves, so the setting survives).
// ---------------------------------------------------------------------------
function agentDir(): string {
    return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function settingsFilePath(): string {
    return join(agentDir(), "settings.json");
}

function isSendAbortedEnabled(): boolean {
    try {
        const file = settingsFilePath();
        if (!existsSync(file)) {
            return SETTINGS_DEFAULT;
        }
        const settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        const value = settings[SETTINGS_KEY];
        return typeof value === "boolean" ? value : SETTINGS_DEFAULT;
    } catch (err) {
        console.error("[resume-extension] could not read settings:", err);
        return SETTINGS_DEFAULT;
    }
}

function setSendAbortedEnabled(enabled: boolean): boolean {
    try {
        const file = settingsFilePath();
        const settings: Record<string, unknown> = existsSync(file)
            ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)
            : {};
        settings[SETTINGS_KEY] = enabled;
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf8");
        renameSync(tmp, file);
        return true;
    } catch (err) {
        console.error("[resume-extension] could not write settings:", err);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Aborted-message transform
// ---------------------------------------------------------------------------
function isAbortedAssistant(msg: unknown): msg is AssistantMessageLike {
    const m = msg as AssistantMessageLike;
    return m?.role === "assistant" && m.stopReason === "aborted";
}

function hasStreamedText(msg: AssistantMessageLike): boolean {
    return (msg.content ?? []).some(
        (block) =>
            block.type === "text" &&
            typeof block.text === "string" &&
            block.text.trim().length > 0
    );
}

/**
 * Make an aborted assistant message sendable to the LLM:
 * - strip incomplete toolCall blocks (no tool results exist for an aborted turn)
 * - neutralize the stop reason, otherwise pi's provider layer
 *   (`transformMessages`) drops the message before it reaches the model
 */
function makeAbortedMessageSendable(msg: AssistantMessageLike): void {
    msg.stopReason = "stop";
    msg.content = (msg.content ?? []).filter((block) => block.type !== "toolCall");
}

/**
 * Custom editor that intercepts the submit key (Enter) when the editor is empty.
 * Everything else is delegated to the default behavior via super.handleInput().
 */
class ResumeEditor extends CustomEditor {
    private kb: KeybindingsManager;
    private onEmptySubmit: () => boolean;

    constructor(
        tui: TUI,
        theme: EditorTheme,
        keybindings: KeybindingsManager,
        onEmptySubmit: () => boolean
    ) {
        super(tui, theme, keybindings);
        this.kb = keybindings;
        this.onEmptySubmit = onEmptySubmit;
    }

    override handleInput(data: string): void {
        // Empty editor + submit key (Enter, remap-aware) => candidate for resume.
        if (
            this.kb.matches(data, "tui.input.submit") &&
            this.getText().trim() === ""
        ) {
            if (this.onEmptySubmit()) {
                // Consumed: a continuation was triggered. Do not submit anything.
                return;
            }
            // Fall through: no aborted message to continue, behave like a normal
            // empty submit (the app's onSubmit ignores empty text anyway).
        }
        super.handleInput(data);
    }
}

export default function (pi: ExtensionAPI): void {
    let uiAvailable = false;

    pi.on("session_start", (_event, ctx) => {
        // Terminal-only: installing a custom editor requires the TUI.
        if (ctx.mode !== "tui" || !ctx.hasUI) {
            uiAvailable = false;
            return;
        }
        uiAvailable = true;

        ctx.ui.setEditorComponent((tui, theme, keybindings) => {
            return new ResumeEditor(tui, theme, keybindings, () =>
                maybeResumeAborted(ctx)
            );
        });
    });

    // -----------------------------------------------------------------------
    // Context transform — runs before every LLM call.
    //
    // 1. Markers (from empty-Enter resume) are removed from context on every
    //    call; they must never reach the LLM.
    // 2. When `send_aborted_message` is enabled (default), every text-bearing
    //    aborted assistant message is made sendable, so a normal "continue"
    //    typed after an abort keeps the partial text in context.
    // -----------------------------------------------------------------------
    pi.on("context", (event) => {
        const messages = event.messages;
        const isMarker = (m: unknown) =>
            (m as { role?: string }).role === "custom" &&
            (m as { customType?: string }).customType === MARKER_TYPE;

        const hasMarker = messages.some(isMarker);
        const sendAborted = isSendAbortedEnabled();

        if (!hasMarker && !sendAborted) {
            return undefined;
        }

        let changed = false;
        const next: unknown[] = [];
        for (const m of messages) {
            if (isMarker(m)) {
                changed = true;
                continue; // never sent to the LLM
            }
            if (sendAborted && isAbortedAssistant(m) && hasStreamedText(m)) {
                changed = true;
                const copy = { ...m, content: [...(m.content ?? [])] };
                makeAbortedMessageSendable(copy);
                next.push(copy);
                continue;
            }
            next.push(m);
        }
        return changed ? { messages: next as AssistantMessageLike[] } : undefined;
    });

    // -----------------------------------------------------------------------
    // Toggle command: /send-aborted [on|off] — flips send_aborted_message.
    // -----------------------------------------------------------------------
    pi.registerCommand("send-aborted", {
        description:
            "Toggle sending aborted assistant messages to the model (settings.json `send_aborted_message`, default on). Usage: /send-aborted [on|off]",
        handler: async (args, ctx) => {
            const arg = args.trim().toLowerCase();
            let next: boolean;
            if (arg === "on") {
                next = true;
            } else if (arg === "off") {
                next = false;
            } else {
                next = !isSendAbortedEnabled();
            }
            const ok = setSendAbortedEnabled(next);
            const label = `send_aborted_message: ${next ? "on" : "off"}`;
            if (ctx.hasUI) {
                ctx.ui.notify(
                    ok ? label : `Failed to save setting (${label})`,
                    ok ? "info" : "error"
                );
            } else {
                console.log(`[resume-extension] ${ok ? label : "failed to save: " + label}`);
            }
        },
    });

    // -----------------------------------------------------------------------
    // Empty-Enter resume: decide whether to resume, and do it.
    // -----------------------------------------------------------------------
    function maybeResumeAborted(ctx: ExtensionContext): boolean {
        try {
            if (!isSendAbortedEnabled()) {
                return false;
            }
            if (!ctx.isIdle() || ctx.hasPendingMessages()) {
                return false;
            }

            const last = lastAssistantMessage(ctx);
            if (!last) {
                return false;
            }

            const msg = last.message as {
                stopReason?: string;
                content?: Array<{ type: string; text?: string; thinking?: string }>;
            };
            if (msg.stopReason !== "aborted") {
                return false;
            }

            // Only streamed TEXT can be replayed as content and continued
            // (thinking alone is dropped by the provider layer anyway).
            const hasText = (msg.content ?? []).some(
                (block) => block.type === "text" && block.text?.trim()
            );
            if (!hasText) {
                return false;
            }

            void triggerResume(ctx);
            return true;
        } catch (err) {
            console.error("[resume-extension] check failed:", err);
            return false;
        }
    }

    function lastAssistantMessage(
        ctx: ExtensionContext
    ): { message: unknown; id: string } | undefined {
        const branch = ctx.sessionManager.getBranch();
        for (let i = branch.length - 1; i >= 0; i--) {
            const entry = branch[i];
            if (
                entry.type === "message" &&
                (entry as { message?: { role?: string } }).message?.role === "assistant"
            ) {
                return entry as { message: unknown; id: string };
            }
        }
        return undefined;
    }

    async function triggerResume(ctx: ExtensionContext): Promise<void> {
        if (uiAvailable) {
            ctx.ui.notify("Resuming aborted response…", "info");
        }
        try {
            // Invisible marker message; triggerTurn runs the agent. The `context`
            // handler removes it before it reaches the LLM.
            await pi.sendMessage(
                {
                    customType: MARKER_TYPE,
                    content: MARKER_FALLBACK_TEXT,
                    display: false,
                    details: {},
                },
                { triggerTurn: true }
            );
        } catch (err) {
            console.error("[resume-extension] failed to trigger resume:", err);
            if (uiAvailable) {
                ctx.ui.notify(
                    `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
                    "error"
                );
            }
        }
    }
}
