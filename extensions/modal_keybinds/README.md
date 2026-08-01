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

### Options

| Option                | Effect                                                        |
|-----------------------|---------------------------------------------------------------|
| `modal.timeoutMs`     | How long to wait for the next key before cancelling (default 5000) |
| `modal.bindings`      | `prefix keyId` → map of second-level `keyId` → binding        |

### Key ids

Prefixes and second-level keys use the same format as `keybindings.json`
(`ctrl+x`, `alt+m`, `shift+l`, `f5`, `up`, …). Letters are lowercase; use `shift+l`
for uppercase.

### Reserved keys

pi **silently skips** extension shortcuts that collide with a set of reserved
built-in keybindings. That includes `ctrl+x` (`app.message.copy`), `ctrl+g`
(`app.editor.external`), `ctrl+p`, `ctrl+l`, `ctrl+o`, `ctrl+t`, `ctrl+k`,
`ctrl+c`, `ctrl+d`, `ctrl+z`, `escape`, `enter`, `alt+enter`, `shift+tab`.

To use one of those as a modal prefix, rebind the built-in away from it in the
**same file** (then `/reload`):

```json
{
  "app.message.copy": ["ctrl+shift+x"],
  "modal": { "bindings": { "ctrl+x": { "l": { "type": "model" } } } }
}
```

The extension checks your prefixes at load time and warns (with a concrete
`keybindings.json` suggestion) if a prefix is still reserved.

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
{ "modal": { "bindings": { "ctrl+x": { "y": { "type": "handler", "name": "myHandler" } } } } }
```

Handlers receive the shortcut `ExtensionContext` and the `ExtensionAPI`, so they can
do anything an extension can (`ctx.compact()`, `pi.setModel()`, `pi.sendUserMessage()`,
`ctx.ui.*`, …). Note they do **not** have `ExtensionCommandContext`, so
`ctx.newSession()` / `ctx.fork()` / `ctx.reload()` are not available from a handler —
route those through `message`/`editor` actions or an extension command instead.

## Legacy config

The old `~/.pi/agent/modal_keybinds.json` file still works (same shape as the
`"modal"` block above). It is merged after the defaults but before the
`keybindings.json` block, so the `"modal"` block wins. It's deprecated — move
your config into `keybindings.json` when convenient.

## Behavior

- While a prefix is waiting for the second key, a menu widget is shown above the
  editor listing the available keys, plus a footer status. `esc`/`ctrl+c` cancels.
- Unmatched keys are consumed (they don't leak into the editor) — you stay in the
  chain until you pick a valid key, cancel, or the `timeoutMs` elapses.
- `/modal_keybinds` prints the currently configured prefixes and config source.
- Slash commands can't be executed programmatically by pi's extension API, so to
  bind a command use `{ "type": "editor", "text": "/compact" }` (pre-fills, press
  Enter), or implement it as a `handler`.

## Default bindings

| Sequence        | Action                    |
|-----------------|---------------------------|
| `alt+x` `c`     | Compact conversation      |
| `alt+x` `m`     | Switch model (picker)     |
| `alt+x` `e`     | Append newline to editor  |
| `alt+x` `f`     | "Fix the latest errors."  |
| `alt+x` `d`     | Toggle demo widget        |
| `alt+x` `g` `b` | Notify "agb"              |
| `alt+x` `g` `r` | Notify "agr"              |
| `alt+x` `g` `s` | Paste "hello from …"      |

## Testing

Run pi and press `alt+x` then `c`. The menu widget should appear above the editor
listing `C compact · M switch model …`, and `c` should start a compaction. To try
`ctrl+x`, add the `app.message.copy` rebind + `"ctrl+x"` prefix from the example
above and `/reload`.
