# Resume extension — TLDR

Two behaviors:

1. **Send aborted messages (default ON).** pi's provider layer
   (`transformMessages` in `pi-ai/dist/api/transform-messages.js`) **drops**
   assistant messages whose `stopReason` is `"aborted"` before they reach the
   model. So after you abort a reply, typing "continue" produced a fresh answer —
   the model never saw the partial text. This extension re-includes text-bearing
   aborted messages in the context (incomplete `toolCall` blocks stripped, stop
   reason neutralized to `"stop"`), so the model continues from where it was cut
   off.

   Setting: `"send_aborted_message": true` in `~/.pi/agent/settings.json`
   (default when absent: **true**). Toggle with `/send-aborted` or
   `/send-aborted on|off`.

2. **Continue on empty Enter.** When the editor is EMPTY and Enter (the submit
   key) is pressed while the last assistant message was aborted (and has streamed
   text), this extension resumes that response: the partial assistant message is
   kept as the final context item sent to the LLM, which continues writing from
   the cut-off point — mirroring the "Continue Response" button in Open WebUI.
   Requires `send_aborted_message` to be enabled (it is by default).

## How "continue" works at the API level

- Continue = a **normal chat-completion request** whose conversation context ends
  with the partial assistant message being continued.
- Because chat-completion models are autoregressive (next-token prediction), the
  model keeps writing from where that message stopped.
- The provider returns **only the new tokens** — it never echoes the partial text
  back, and it has no concept of "unfinished".
- Producing one continuous message requires the **client** to merge: reload the
  stored partial message, seed the response with it, append the streamed tokens,
  and save the combined text. The provider just returns a delta.

## pi-specific facts

- Aborted messages are persisted with `stopReason: "aborted"` and **keep whatever
  streamed** (thinking blocks, tool calls, partial text). Verified in real session
  JSONL under `~/.pi/agent/sessions/`.
- The aborted message stays in agent state and in the `context` extension event —
  **but** the provider layer (`transformMessages`, used by every provider:
  openai-completions, openai-responses, anthropic, bedrock, google, mistral)
  skips assistant messages with `stopReason === "aborted"` (added to fix OpenAI
  Responses 400 "reasoning without following item", PR #838). That is why a
  naive "continue" after an abort starts fresh.
- The fix: the `context` handler neutralizes the stop reason (`"aborted"` →
  `"stop"`) and strips incomplete `toolCall` blocks before the provider call.
- pi has **no message-merge primitive**: the session manager exposed to extensions
  is read-only, and the only message-mutation hook (`message_end`) applies to the
  message being finalized, not past ones. So the continuation lands as a **new**
  assistant message after the aborted one (textually continuous, structurally
  separate).
- `agent.continue()` cannot continue from an assistant message (throws), so the
  extension triggers the turn itself.

## How the extension works

1. **Intercept** (resume feature): a `CustomEditor` wraps the default editor; on
   the submit key (Enter, remap-aware) with an empty/whitespace editor, it checks
   for a resume candidate instead of the usual no-op.
2. **Check**: `send_aborted_message` enabled + idle session + last assistant message
   has `stopReason === "aborted"` and streamed text. Otherwise Enter stays a no-op.
3. **Trigger**: sends an invisible custom marker message (`display: false`) with
   `triggerTurn: true` → starts a new agent turn.
4. **Transform**: the `context` extension event removes markers (always) and makes
   every text-bearing aborted assistant message sendable (when the setting is on):
   strip incomplete `toolCall` blocks, set `stopReason` to `"stop"`. The provider
   receives `[history…, assistant: "<partial text>", user: "continue"]` (or, on a
   resume turn, ends with the partial assistant message) and continues the text.

## Limitations

- Continuation is a new message, not merged into the aborted one.
- The aborted message keeps its "Operation aborted" footer.
- Providers that reject a trailing assistant message won't work; OpenAI-compatible
  chat completions accept it.
- If the abort happened before any text streamed (thinking only), there is nothing
  replayable as content; Enter falls through to the default no-op.
- The setting is read from `settings.json`; pi itself exposes no settings API to
  extensions. pi preserves unknown keys when it saves, so `send_aborted_message`
  survives restarts. `PI_CODING_AGENT_DIR` is honored when set.
