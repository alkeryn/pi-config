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
pi ignores it, the extension reads it. `"modal"` entries are deep-merged over the
extension's built-in defaults, so you only need to list what you want to change.
An annotated example lives in `keybindings.example.json`.

```json
{
  "app.message.copy": ["ctrl+shift+x"],

  "modal": {
    "timeoutMs": 7000,
    "bindings": {
      "ctrl+x": {
        "c": { "type": "compact", "label": "Compact conversation" },
        "m": { "type": "model", "label": "Switch model" },
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
| `modal.timeoutMs`     | How long to wait for the next key before cancelling (default 5000) |
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
| `compact`         | —                  | Compact the conversation (`ctx.compact()`)                 |
| `model`           | —                  | Open pi's **native** model selector (the same component `/model` opens, rendered via `ctx.ui.custom()`) — with search, provider filtering and model switching. Your editor text is **preserved** while the selector is open and restored when it closes |
| `copy`            | —                  | Copy the last assistant message (like pi's `app.message.copy`) |
| `handler`         | `name`             | Run a JS handler — first this extension's `handlers` map, then the shared cross-extension registry (`globalThis.__piExtensionHandlers`), so other extensions (e.g. `undo-redo`) can expose callable functions |

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

### External handlers (calling functions from other extensions)

If the name is not in this extension's `handlers` map, it is looked up in a shared
cross-extension registry on `globalThis.__piExtensionHandlers`. Any extension can
register callable functions there, and keybindings.json can invoke them with the
same `handler` action:

```json
{ "modal": { "bindings": { "ctrl+x": {
  "u": { "type": "handler", "name": "undo", "label": "Undo last message" },
  "r": { "type": "handler", "name": "redo", "label": "Redo last message" }
} } } }
```

The bundled **`undo-redo`** extension (install it alongside this one) registers
`undo` and `redo` — `/undo` reverts to the last user message (same as selecting it
in `/tree` without a summary), `/redo` restores the abandoned turn. From a modal
keybind, undo/redo run the command through the editor submit path, so the session
and chat stay fully in sync; if the editor holds a draft the key is ignored with a
notification rather than clobbering it.

Resolution order: local `handlers` first, then the global registry.

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
  chain until you pick a valid key, cancel, or the `timeoutMs` elapses.
- `/modal_keybinds` prints the currently configured prefixes and config source.
- Slash commands can't be invoked programmatically by pi's extension API, so for
  most commands use `{ "type": "editor", "text": "/compact" }` (pre-fills, press
  Enter). `model` is the exception: it renders pi's own `ModelSelectorComponent`
  directly (via `ctx.ui.custom()`), so you get the native selector with search and
  provider filtering — and, unlike typing `/model`, your editor text is not lost.

## Default bindings

| Sequence        | Action                    |
|-----------------|---------------------------|
| `alt+x` `c`     | Compact conversation      |
| `alt+x` `m`     | Open model selector (native, editor text preserved) |
| `alt+x` `e`     | Append newline to editor  |
| `alt+x` `f`     | "Fix the latest errors."  |
| `alt+x` `d`     | Toggle demo widget        |
| `alt+x` `g` `b` | Notify "agb"              |
| `alt+x` `g` `r` | Notify "agr"              |
| `alt+x` `g` `s` | Paste "hello from …"      |

## Testing

Run pi and press `alt+x` then `c`. The menu widget should appear above the editor
listing `C compact · M switch model …`, and `c` should start a compaction. To try
`ctrl+x`, add the `"ctrl+x"` prefix from the example above and `/reload` (the
`app.message.copy` rebind is optional). No startup warning should appear, and in a
`/scoped-models` selector `ctrl+x` should still clear the model list instead of
opening the modal.
