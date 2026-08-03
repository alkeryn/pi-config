/**
 * Resume interrupted responses + send incomplete assistant messages to the model
 * (pi extension)
 *
 * Two related behaviors:
 *
 * 1. **Send incomplete messages (opt-in, setting `send_aborted_message`).**
 *    pi's provider layer (`transformMessages`) silently drops assistant
 *    messages whose `stopReason` is `"aborted"` **or** `"error"`, so after you
 *    abort a reply (or a turn fails mid-stream) the model has no idea what it
 *    was writing — typing "continue" starts a fresh answer. When enabled, this
 *    extension re-includes text-bearing incomplete assistant messages in the
 *    context sent to the model (incomplete toolCall blocks stripped, stop
 *    reason neutralized), so the model continues from where it was cut off.
 *
 *    Setting: `"send_aborted_message": true` in `~/.pi/agent/settings.json`
 *    (default when absent: **false** — pi's normal behavior). Toggle with
 *    `/send-aborted` or `/send-aborted on|off`. Covers both aborted and errored
 *    turns.
 *
 * 2. **Continue on empty Enter.** When the editor is EMPTY and Enter (the
 *    submit key) is pressed while the last assistant message was interrupted
 *    (stopReason `"aborted"` or `"error"`, and has streamed text), this
 *    extension resumes that response — mirroring the "Continue Response"
 *    button in Open WebUI. Works regardless of `send_aborted_message`:
 *    - **on**: the partial assistant message is kept as the final context item
 *      sent to the LLM, which continues writing from the cut-off point;
 *    - **off**: the partial text is NOT sent (pi's provider layer drops it as
 *      usual) and the model starts a fresh response to an invisible "Continue"
 *      prompt.
 *
 * Mechanism:
 *   1. A CustomEditor wraps the default editor and intercepts the submit key on
 *      an empty editor.
 *   2. If the last assistant message was interrupted (and has text), it injects
 *      an invisible custom marker message and triggers a new agent turn.
 *   3. The `context` extension event removes the marker (always; when
 *      `send_aborted_message` is off it becomes an invisible "Continue" user
 *      prompt instead, since the partial text is dropped) and, when the setting
 *      is on, makes incomplete assistant messages sendable, so the provider
 *      sees [history…, assistant: "<partial text>"] and continues the partial
 *      text (or [history…, user: "Continue"] for a fresh response).
 *
 * The continuation appears as a new assistant message following the interrupted
 * one.
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
 * transform consumes the marker before the provider call: when
 * `send_aborted_message` is on it is removed entirely (the partial assistant
 * text is the final context item); when off it becomes an invisible user
 * "Continue" prompt (the partial text is dropped). This text only matters if
 * that transform fails (extension error): the model would then see a short
 * "Continue" user message, which still points it at the interrupted text.
 */
const MARKER_FALLBACK_TEXT = "Continue";

/**
 * settings.json key controlling behavior (1): send incomplete assistant
 * messages (stopReason "aborted" or "error") to the model. Default false when
 * the key is absent (pi's normal behavior: incomplete turns are dropped).
 */
const SETTINGS_KEY = "send_aborted_message";
const SETTINGS_DEFAULT = false;

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
// Incomplete-message transform
// ---------------------------------------------------------------------------
/**
 * An assistant message whose turn was interrupted: user-aborted ("aborted") or
 * failed mid-stream ("error"). pi's provider layer (`transformMessages`)
 * skips both stop reasons, so neither reaches the model by default.
 */
function isIncompleteAssistant(msg: unknown): msg is AssistantMessageLike {
    const m = msg as AssistantMessageLike;
    return m?.role === "assistant" &&
        (m.stopReason === "aborted" || m.stopReason === "error");
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
 * Make an incomplete assistant message sendable to the LLM:
 * - strip incomplete toolCall blocks (no tool results exist for an
 *   aborted/errored turn)
 * - neutralize the stop reason, otherwise pi's provider layer
 *   (`transformMessages`) drops the message before it reaches the model
 */
function makeIncompleteMessageSendable(msg: AssistantMessageLike): void {
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
                maybeResumeIncomplete(ctx)
            );
        });
    });

    // -----------------------------------------------------------------------
    // Context transform — runs before every LLM call.
    //
    // 1. Markers (from empty-Enter resume) are dropped when `send_aborted_message`
    //    is on (the partial assistant text becomes the final context item). When
    //    the setting is off the marker is converted into an invisible "Continue"
    //    user prompt, since the interrupted message is dropped by pi's provider
    //    layer and the model still needs a user turn.
    // 2. When `send_aborted_message` is enabled (opt-in), every text-bearing
    //    incomplete assistant message (stopReason "aborted" or "error") is made
    //    sendable, so a normal "continue" typed after an abort (or a failed
    //    turn) keeps the partial text in context.
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
                if (sendAborted) {
                    // Setting on: the interrupted message below is made sendable
                    // and serves as the final context item, so drop the marker
                    // entirely — never sent to the LLM.
                    continue;
                }
                // Setting off: the interrupted assistant message is dropped by
                // pi's provider layer, so turn the invisible marker into a
                // fresh "Continue" user prompt — otherwise the model would get
                // no user turn at all.
                const marker = m as unknown as {
                    content?: string | ContentBlock[];
                    id?: string;
                    timestamp?: string;
                };
                const userMessage: Record<string, unknown> = {
                    role: "user",
                    content: marker.content ?? MARKER_FALLBACK_TEXT,
                };
                if (marker.id !== undefined) {
                    userMessage.id = marker.id;
                }
                if (marker.timestamp !== undefined) {
                    userMessage.timestamp = marker.timestamp;
                }
                next.push(userMessage);
                continue;
            }
            if (sendAborted && isIncompleteAssistant(m) && hasStreamedText(m)) {
                changed = true;
                const copy = { ...m, content: [...(m.content ?? [])] };
                makeIncompleteMessageSendable(copy);
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
            "Toggle sending aborted/errored assistant messages to the model (settings.json `send_aborted_message`, default off). Usage: /send-aborted [on|off]",
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
    function maybeResumeIncomplete(ctx: ExtensionContext): boolean {
        try {
            // Works regardless of send_aborted_message: with the setting on the
            // partial text is replayed to the model (it continues the text);
            // with it off the partial text is dropped (fresh response).
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
            if (msg.stopReason !== "aborted" && msg.stopReason !== "error") {
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
            ctx.ui.notify(
                isSendAbortedEnabled()
                    ? "Resuming interrupted response…"
                    : "Continuing…",
                "info"
            );
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
