# modal_keybinds

Modal (multi-key) keybindings for [pi](https://github.com/earendil-works/pi-coding-agent).

Press a **prefix** key, then a second (or third...) key — like emacs key chords or a
vim leader key — and pi runs the bound action. Example: `ctrl+x` then `l` switches
the model.

## Installation

**Global** (recommended): the folder lives at `~/.pi/agent/extensions/modal_keybinds/`
and applies to every project.

**Project-local**: copy the folder to `.pi/extensions/modal_keybinds/` (loaded only
after the project is trusted).

Then `/reload` (or restart pi).

## Configuration

Everything lives in the **same file as pi's own keybindings**:
`~/.pi/agent/keybindings.json`. Put your modal bindings under a `"modal"` block —
pi ignores it, the extension reads it. The extension ships with **no built-in
bindings**: the modal menu shows exactly what you configure here (the empty
built-in defaults still exist as a merge base, so old configs keep working).
An annotated example lives in `keybindings.example.json`.

```json
{
  "app.message.copy": ["ctrl+shift+x"],

  "modal": {
    "timeout_ms": 7000,
    "bindings": {
      "ctrl+x": {
        "c": { "type": "compact", "label": "Compact conversation" },
        "m": { "type": "action", "name": "app.model.select", "label": "Switch model" },
        "e": { "type": "action", "name": "app.editor.external", "label": "Open external editor" },
        "f": { "type": "message", "text": "Fix the latest errors.", "label": "Fix errors" },
        "g": {
          "b": { "type": "notify", "message": "ctrl+x g b", "label": "agb" },
          "r": { "type": "notify", "message": "ctrl+x g r", "label": "agr" }
        }
      }
    }
  }
}
```

Why this is safe: pi's keybinding parser keeps only string / string-array values for
ids it knows and silently discards everything else, so the `"modal"` block (an
object value under an unknown id) never interferes with pi's own keybindings.

The `app.message.copy` rebind is **optional** — prefixes are handled by the
extension directly (no pi shortcut is registered), so there is no conflict and no
startup warning. Keep the rebind if you still want `ctrl+x`-free access to copy in
the editor, or drop it if you don't need copy.

### Options

| Option                | Effect                                                        |
|-----------------------|---------------------------------------------------------------|
| `modal.timeout_ms`    | How long to wait for the next key before cancelling. **Omitted = no timeout** (waits until a key, `escape`, or `ctrl+c`) |
| `modal.bindings`      | `prefix keyId` → map of second-level `keyId` → binding        |

### Key ids

Prefixes and second-level keys use the same format as `keybindings.json`
(`ctrl+x`, `alt+m`, `shift+l`, `f5`, `up`, …). Letters are lowercase; use `shift+l`
for uppercase.

### Where prefixes fire

Prefixes are matched by a single TUI-level input listener, **not** by
`pi.registerShortcut`, so:

- A prefix only fires while the **input editor is focused**. In selectors and
  overlays the key passes through untouched — e.g. `/scoped-models` keeps its own
  `ctrl+x` **clear**, and `ctrl+x` never pops the modal menu there.
- No built-in key is "reserved" and no shortcut-conflict warning is printed at
  startup, whatever key you pick for a prefix.
- While the editor is focused, a prefix key is captured before the editor sees it,
  so it shadows that key's editor meaning (that's the point of a modal prefix).

### Design notes / maintenance

Prefix handling does **not** use `pi.registerShortcut` (that would make pi emit a
startup conflict warning for keys like `ctrl+x`, which is also bound to
`app.models.clearAll` / `/scoped-models` "clear"). Instead a single
`ctx.ui.onTerminalInput` listener detects prefix presses, and only starts a modal
when the focused component is the input editor. This depends on a few pi
internals that are not a documented extension API:

- `tui.focusedComponent instanceof Editor` (captured from an invisible empty
  widget) — relies on pi's editor class hierarchy and on the extension sharing
  pi's pi-tui module instance.
- Per-session (re)registration via `session_start`/`session_shutdown`, because
  extension contexts go stale when the session is replaced.

If a pi update breaks any of these (silent failure: prefixes stop firing), the
fallback is trivial: go back to `pi.registerShortcut(prefix, …)` per prefix and
accept the cosmetic startup warning, or rebind the colliding built-in
(e.g. `"app.models.clearAll": ["ctrl+shift+a"]`).

### Action types

| Type              | Fields             | Effect                                                    |
|-------------------|--------------------|-----------------------------------------------------------|
| `notify`          | `message`          | Show a notification                                        |
| `message`         | `text`             | Send `text` to the agent (queued as follow-up if busy)     |
| `editor`          | `text`             | Replace editor content                                     |
| `editorAppend`    | `text`             | Append to editor content                                   |
| `editorPrepend`   | `text`             | Prepend to editor content                                  |
| `paste`           | `text`             | Paste into editor (with paste handling)                    |
| `compact`         | —                  | Compact the conversation (`ctx.compact()`) — the one case below that **cannot** be an `action`: pi registers no app action for it (only the `/compact` text command), so it uses the extension API directly |
| `key`             | `key`              | Replay a keypress through pi's own input pipeline — the focused component's keybinding matching runs exactly as if the user pressed that key. For app actions prefer `action` (below); use this for keys that aren't app actions (e.g. editor navigation chords) |
| `action`          | `name`             | Invoke an app action **by name** — looks up the handler pi registered on the focused editor's `actionHandlers` map and calls it directly. Same handler a keybinding press would run, but no keybinding lookup: works even if the action is unbound or rebound (e.g. `app.editor.external` = open external editor) |
| `handler`         | `name`             | Run a JS handler — first this extension's `handlers` map; a name containing `:` is emitted as a channel on `pi.events` (with `{ ctx, pi }`), so any other extension can react without modal_keybinds knowing it |

`label` is optional on any action and is shown in the modal menu widget.

### Custom JS handlers

Edit the `handlers` map in `index.ts` and reference it from config:

```typescript
export const handlers: Record<string, CustomHandler> = {
  myHandler: (ctx, pi) => {
    ctx.ui.notify("custom handler ran!", "info");
  },
};
```

```json
{ "modal": { "bindings": { "ctrl+x": { "y": { "type": "handler", "name": "myHandler" } } } } }
```

Handlers receive the shortcut `ExtensionContext` and the `ExtensionAPI`, so they can
do anything an extension can (`ctx.compact()`, `pi.setModel()`, `pi.sendUserMessage()`,
`ctx.ui.*`, …). Note they do **not** have `ExtensionCommandContext`, so
`ctx.newSession()` / `ctx.fork()` / `ctx.reload()` are not available from a handler —
route those through `message`/`editor` actions or an extension command instead.

### Handler names: local map, or an event-bus channel

If the name is not in this extension's `handlers` map and contains a `:`, it is
treated as an **event channel on `pi.events`** — pi's shared, documented event bus
("Shared event bus for extension communication"). modal_keybinds emits `{ ctx, pi }`
on that channel and any extension may subscribe. This keeps modal_keybinds
completely unaware of which extension (if any) listens:

```json
{ "modal": { "bindings": { "ctrl+x": {
  "y": { "type": "handler", "name": "some-extension:do-thing", "label": "External handler" }
} } } }
```

The `ctx` and `pi` received by the subscriber are the same as for local handlers
(the shortcut `ExtensionContext` and the `ExtensionAPI`). The channel name is
whatever you and the extension you coordinate with agree on — there is no shared
registry and no global state; the name is the contract.

Note: `pi.events.emit` is fire-and-forget — if nothing subscribes to the channel,
the key press silently does nothing (check for typos in the `name`).

### Invoking app actions: the `action` type

`{ "type": "action", "name": "app.editor.external" }` looks up the handler pi
registered for that action on the focused editor's `actionHandlers` map (every
app action — `app.editor.*`, `app.message.*`, `app.navigation.*`, … — is
registered there while the interactive editor is focused) and calls it directly:
the **same handler a keybinding press would run**, but with no keybinding
lookup. So `ctrl+x` `e` opens the configured external editor with the current
draft exactly like `ctrl+g` — and keeps working even if you rebind or unbind
`ctrl+g` in pi's keybindings.json.

Common actions the interactive mode registers: `app.model.select` (native model
selector — search, provider filtering, editor text preserved), `app.message.copy`
(copy last assistant message), `app.editor.external` (open external editor),
`app.session.new` / `app.session.resume` / `app.session.tree` / `app.session.fork`,
`app.thinking.toggle`, `app.tools.expand`, `app.model.cycleForward`. Since there
are no built-in bindings, wire any of these up in one line of config — the example
file shows `m`/`x`/`e`/`l`/`n` bound to the common ones.
(`compact` is the one thing that can't be an action — see the table above.)

### Replaying keys: the `key` action

`{ "type": "key", "key": "ctrl+g" }` replays that keypress through the TUI's
normal input pipeline (input listeners → focused component). The editor's own
keybinding matching then dispatches the bound app action — the result is the
same, but it depends on the action actually being bound to that key (if you
rebind `ctrl+g`, the replay follows the new action). Prefer `action` for app
actions; `key` is the fallback for keys that are **not** app actions (e.g.
editor navigation chords handled by pi-tui itself).

Supported key ids for `key`: printable keys (`g`, `1`, `/`, …), `ctrl`/`alt`/`shift`
combinations of them (`ctrl+g`, `alt+x`, `shift+l`, `ctrl+alt+g`, `ctrl+shift+g`),
navigation keys with modifiers (`up`, `shift+left`, `ctrl+home`, `alt+up`, …), and
`f1`–`f12` (unmodified). Keys that pi's own matcher cannot match are rejected
with a notification instead of replayed (e.g. `ctrl+f1`, `super+x`).

## Legacy config

The old `~/.pi/agent/modal_keybinds.json` file still works (same shape as the
`"modal"` block above). It is merged after the defaults but before the
`keybindings.json` block, so the `"modal"` block wins. It's deprecated — move
your config into `keybindings.json` when convenient.

## Behavior

- While a prefix is waiting for the second key, a menu widget is shown above the
  editor listing the available keys, plus a footer status. `esc`/`ctrl+c` cancels.
- Prefixes only fire while the input editor is focused; in selectors/overlays the
  key is left untouched for the focused component (e.g. `ctrl+x` stays "clear" in
  `/scoped-models`).
- Key release/repeat events are ignored while waiting: the next key must be a
  genuine fresh press (so `ctrl+x`, releasing ctrl, then releasing `x` doesn't
  false-trigger an `x` binding — press `x` again to fire it).
- Unmatched keys are consumed (they don't leak into the editor) — you stay in the
  chain until you pick a valid key, cancel, or the `timeout_ms` elapses (if set).
- `/modal_keybinds` prints the currently configured prefixes and config source.
- Slash commands can't be invoked programmatically by pi's extension API, so for
  most commands use `{ "type": "editor", "text": "/compact" }` (pre-fills, press
  Enter). App actions that pi registers on the editor (model selector, copy,
  external editor, session new/resume, …) are invoked **natively** via
  `{ "type": "action", "name": … }` — no text round-trip, and editor text is
  preserved by pi's own overlay handling.

## Default bindings

**None.** The extension ships with an empty binding map — nothing is bound out of
the box. The modal menu shows only the prefixes and keys you configure in
`keybindings.json` (or the legacy file). `keybindings.example.json` has a fully
annotated example to copy from.

## Testing

Run pi, add a prefix from `keybindings.example.json` (or your own) and `/reload`.
The menu widget should appear above the editor listing the configured keys, and a
second key should run the bound action. No startup warning should appear, and in a
`/scoped-models` selector a prefix like `ctrl+x` should still clear the model list
instead of opening the modal.
