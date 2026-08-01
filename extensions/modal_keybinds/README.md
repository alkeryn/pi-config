# modal_keybinds

Modal (multi-key) keybindings for [pi](https://github.com/earendil-works/pi-coding-agent).

Press a **prefix** key, then a second (or third...) key — like emacs key chords or a
vim leader key — and pi runs the bound action. Example: `ctrl+x` then `l` switches
the model.

## Installation

**Project-local** (this folder): lives at `.pi/extensions/modal_keybinds/` and is
auto-discovered once the project is trusted. Apply with `/reload`.

**Global**: copy the folder to `~/.pi/agent/extensions/modal_keybinds/` so it applies
to every project.

```
cp -r .pi/extensions/modal_keybinds ~/.pi/agent/extensions/
```

Then `/reload` (or restart pi).

## Configuration

Create `~/.pi/agent/modal_keybinds.json`. It is **deep-merged** over the defaults
compiled into the extension, so you only need to write the parts you want to change.
An annotated example lives in `modal_keybinds.example.json`.

```json
{
  "timeoutMs": 5000,
  "bindings": {
    "alt+x": {
      "l": { "type": "model", "label": "Switch model" },
      "c": { "type": "compact", "label": "Compact conversation" },
      "f": { "type": "message", "text": "Fix the latest errors.", "label": "Fix errors" }
    }
  }
}
```

### Key ids

Prefixes and second-level keys use the same format as `keybindings.json`
(`ctrl+x`, `alt+m`, `shift+l`, `f5`, `up`, …). Letters are lowercase; use `shift+l`
for uppercase.

### Reserved keys (important)

pi **silently skips** extension shortcuts that collide with a set of reserved
built-in keybindings. That includes `ctrl+x` (`app.message.copy`), `ctrl+g`
(`app.editor.external`), `ctrl+p`, `ctrl+l`, `ctrl+o`, `ctrl+t`, `ctrl+k`,
`ctrl+c`, `ctrl+d`, `ctrl+z`, `escape`, `enter`, `alt+enter`, `shift+tab`.

To use one of those as a modal prefix, first rebind the built-in away from it in
`~/.pi/agent/keybindings.json`, then `/reload`:

```json
{
  "app.message.copy": ["ctrl+shift+x"]
}
```

Now `ctrl+x` is free for your modal prefix:

```json
{
  "bindings": { "ctrl+x": { "l": { "type": "model" } } }
}
```

Non-reserved built-in keys (e.g. `ctrl+b`, cursor movement) are also taken over by
extension shortcuts, with a warning — best to avoid them.

### Nesting

A binding value can be another map of key → binding, giving you chains of any
depth:

```json
"alt+x": {
  "g": {
    "b": { "type": "notify", "message": "you pressed alt+x g b" },
    "r": { "type": "notify", "message": "you pressed alt+x g r" }
  }
}
```

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
| `model`           | —                  | Open a model picker and switch (`ctx.ui.select` + `setModel`) |
| `handler`         | `name`             | Run a JS handler registered in `handlers` (see below)      |

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
{ "bindings": { "alt+x": { "y": { "type": "handler", "name": "myHandler" } } } }
```

Handlers receive the shortcut `ExtensionContext` and the `ExtensionAPI`, so they can
do anything an extension can (`ctx.compact()`, `pi.setModel()`, `pi.sendUserMessage()`,
`ctx.ui.*`, …). Note they do **not** have `ExtensionCommandContext`, so
`ctx.newSession()` / `ctx.fork()` / `ctx.reload()` are not available from a handler —
route those through `message`/`editor` actions or an extension command instead.

## Behavior

- While a prefix is waiting for the second key, a menu widget is shown above the
  editor listing the available keys, plus a footer status. `esc`/`ctrl+c` cancels.
- Unmatched keys are consumed (they don't leak into the editor) — you stay in the
  chain until you pick a valid key, cancel, or the `timeoutMs` elapses.
- `/modal_keybinds` prints the currently configured prefixes.
- Slash commands can't be executed programmatically by pi's extension API, so to
  bind a command use `{ "type": "editor", "text": "/compact" }` (pre-fills, press
  Enter), or implement it as a `handler`.

## Default bindings

| Sequence     | Action                    |
|--------------|---------------------------|
| `alt+x` `c`  | Compact conversation      |
| `alt+x` `m`  | Switch model (picker)     |
| `alt+x` `e`  | Append newline to editor  |
| `alt+x` `f`  | "Fix the latest errors."  |
| `alt+x` `d`  | Toggle demo widget        |
| `alt+x` `g` `b` | Notify "agb"          |
| `alt+x` `g` `r` | Notify "agr"          |
| `alt+x` `g` `s` | Paste "hello from …"  |

## Testing

From a trusted project, run pi and press `alt+x` then `c`. The menu widget should
appear above the editor listing `C compact · M switch model …`, and `c` should start
a compaction.
