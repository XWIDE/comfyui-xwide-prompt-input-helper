# X-WIDE Prompt Input Helper

<img src="https://raw.githubusercontent.com/XWIDE/comfyui-xwide-prompt-input-helper/main/web/logo_xwide.png" alt="X-WIDE — I BELIEVE" width="360">

[中文](README.md) | **English**

![version](https://img.shields.io/badge/version-1.0.4-blue)
![license](https://img.shields.io/badge/license-GPL--3.0-green)
![comfyui](https://img.shields.io/badge/ComfyUI%20frontend-%E2%89%A5%201.3-blue)

A **pass-through** positive / negative prompt overlay for ComfyUI.

Hit a hotkey, paste your prompt in from anywhere, click *Apply & close* —
and the text lands straight in the text widget you were already editing.

**No new nodes. No changes to existing nodes. No rewiring your workflow.**

- Positive: `P`
- Negative: `N`

Plain single letters — no modifier chord. To use something else (including a chord such as
`Ctrl+Alt+P`), open the bottom-left gear → `X-WIDE Prompt Input Helper` (the shortcut row is
**click and press the combination** you want, and it tells you whether it clashes with the
system or with ComfyUI itself).

---

## Why this exists

ComfyUI's built-in multiline widgets are cramped:

- Long prompts show two or three lines, so writing one feels like looking through a keyhole.
- Bringing a prompt in from outside means select-all, delete, paste — and one slip wipes your work.
- The positive and negative boxes are often far apart on the canvas, which makes comparing them painful.
- After pasting from a translation tool, fixing one phrase means hunting for it in a tiny box.

This plugin does not replace the native widget. It just opens two bigger windows
next to it. Your existing habits keep working; when you want room to think, press the hotkey.

## Usage

| Keys | What it does |
| --- | --- |
| `P` | Open the positive prompt overlay (pressing it again re-resolves the target and puts the caret back in the editor — it does **not** close the overlay) |
| `N` | Open the negative prompt overlay (same) |
| `Enter` | Inside the overlay: apply and close (**the main action**) |
| `Shift+Enter` | Inside the overlay: insert a new line |
| `Esc` | Close the overlay (the text is kept as a draft and restored next time) |
| “Close” in the footer | Same as `Esc` — for when you'd rather use the mouse |

> Both overlays can be open at the same time, so you can edit positive and negative side by side.

> All three starting points work: **click the prompt box on the canvas**, **select that node**,
> or just leave the caret on the canvas — then press `P` / `N`. The overlay opens for that role
> and writes back into **the box you just clicked**. With the caret inside a canvas node's big
> text box, `P` / `N` still work; the single keys only step aside while you are typing inside
> our own overlay.

Buttons inside the overlay:

- **Apply & close** — writes back to the target widget. If the write fails you get a
  clear reason and the panel stays open. It will **never** write somewhere you didn't aim at.
- **Clear** — empties the editor **and the target box on the canvas** ("that box is no longer
  wanted"). If the box was already empty only the editor is cleared, and if the target is gone
  the panel says so. Clearing never changes *which* box you are writing to.
- **Auto-paste** (checkbox, on by default) — see the paragraph below.
- **→ Negative / → Positive** — send the whole text to the other panel, handy for
  writing one block and splitting it into positive and negative.

**Copy anywhere and it lands in the panel** (since 1.0.2): with a panel open, select text
anywhere in the page and press `Ctrl+C` — it goes straight into the panel; anything copied
outside the browser is **taken in when you switch back to the page** (since 1.0.3, controlled
by the **auto-paste** checkbox, on by default). That is the natural way to move a prompt over
from a translator, which is why the old **Copy** and **Paste** buttons are gone. Once you have
edited the text yourself, newly received text is **appended** instead of wiping what you wrote.
The same text is only taken in once, and `Ctrl+V` in the page still works too.

> Firefox forbids scripts from reading the clipboard without a key press, so "taken in when you
> switch back" cannot work there — the panel tells you once to press `Ctrl + V`, which works
> fine in Firefox as well.

### Where does it actually write?

The top bar of the overlay always shows *which node and which field* the content is about
to go into, and the line under it states **the evidence** for this decision.

**Positive vs. negative is decided by what the receiving node itself declares**, in this order:
① the box's own name says so → use it; ② follow the wire to the receiving node and see which
**input** it lands on (`positive` / `negative`); ③ the node itself has positive/negative inputs.
If all three fail: the **positive** panel fills as positive (and says so), the **negative** panel
refuses to guess — when a prompt has no sides, it is just a prompt.

With that settled, the target is resolved in this order — **every step first passes a role gate:
if the role is recognisable and it is not the side you asked for, the step is skipped** rather
than "found it, use it":

1. **The text box you just clicked.** If it is this side → that's the one; if it is **the other
   side** (you clicked the negative box and pressed `P`) → the panel looks for its **partner**
   (connected to the same receiving node, role exactly this kind); if its role can't be told →
   treat it as this kind.
2. the single box on the current canvas whose role is **unambiguously** this kind (per above),
   remembering its partner as well;
3. a text widget on the **node you just selected** that resolves to this kind;
4. **pairing**: when the other side's position is certain (uniquely resolvable canvas-wide, or a
   binding you set that still resolves), this side is its other half — this is what handles two
   samplers in one graph, each with its own positive and negative box;
5. **the box you last successfully wrote to** (a per-workflow binding). If the box it points at
   resolves to the *other* side, the binding is pollution written by an older version that could
   not tell positive from negative — it is deleted on the spot instead of being obeyed;
6. whatever genuinely holds focus right now (same role gate);
7. a text widget on the selected node(s), as a fallback;
8. the older memory key from earlier versions (same role gate);
9. when nothing resolves at all: **positive** uses the box you just clicked (the panel says
   "this box's role can't be told, treating it as positive");
10. only then are the candidates listed and you pick one.

Step 5 is **per workflow**, and it is dropped on the spot when the node it points at is
gone or **disabled** (`mode=4`) — that stale binding was the root cause of the reported
"asked for positive, wrote into negative" bug.

If everything comes up empty the panel still opens, but it flags "no target" in red and
**refuses to write** — better to make you pick one than to drop text somewhere you weren't looking.

> Wrong target? Click the box you actually want on the canvas and press `P` / `N` again —
> step 1 outranks everything, so the write follows your click immediately.

### Settings

Settings live in **ComfyUI's own settings panel** (the bottom-left gear, or `Ctrl+,`):
look for `X-WIDE Prompt Input Helper`. It deliberately holds **only three rows** — change the shortcuts,
switch auto-paste on or off, adjust the text size. The plugin's own information (logo, version,
author, usage) does not take up settings rows; it lives on the **About** info page instead.

**Shortcuts — press the combination instead of typing it, with conflict warnings:**

- click a key box and press the combination you want;
- each key gets its **own status line**: `✓ available` / `! easy to trigger by accident`
  (a plain key with no Ctrl / Alt / Shift will fire while you type in someone else's text box) /
  `✕ conflict`;
- conflicts are reported in three kinds: **system / browser reserved** (`Ctrl+W`, `F5`, …),
  **built into ComfyUI** (`Ctrl+S` save, `Ctrl+Enter` queue, … — the live table of what is
  actually active right now is read as well, and the command you clash with is named), and
  **easy to trigger by accident** (`Delete`, `Space`, …);
- the default `P` / `N` already belong to something in ComfyUI (pin the selected node, toggle
  the node-library sidebar), which shows up as a `!` **note**, not a `✕` conflict: the plugin
  listens in the capture phase and swallows the key, so pressing `P` / `N` only opens the
  overlay (verified on a real machine — nothing gets pinned, no sidebar moves). Switch to
  another combo if you want to stay out of the way entirely.
- `Delete` / `Backspace` switches that key **off** (the panel still opens from the canvas
  right-click menu), `Esc` cancels, and there is a *restore defaults* button;
- changes take effect **immediately**, no page reload.

**Auto-paste**: one checkbox in the overlay footer, another one in settings — the same switch,
on by default.

**Text size**: the `A-` / `A+` buttons in the overlay header and the *Text size* row in settings
are the same value (70%–400%; 10% a click, 25% above 200%, plus *restore the default size*).

The overlay's title bar carries `A-` / `A+` / `⚙`; the old `?` has become that
permanent evidence line under the target bar. Right-clicking an empty canvas spot →
*Prompt Helper* reaches settings and *About* — **About** is an info page: logo, version,
`⚖ GPL-3.0`, a disclaimer, *Author & links* (GitHub repository / Bilibili) and two cards for
usage and shortcuts.

## Installation

**Option 1 — copy it in (most direct)**

Drop this whole directory into ComfyUI's `custom_nodes`:

```
ComfyUI/custom_nodes/comfyui-xwide-prompt-helper/
```

Then **restart ComfyUI** (not just the page — new custom_nodes are only picked up on
backend start). After the restart, press `P`; if the overlay appears, you're set.

**Option 2 — ComfyUI Manager**

Search for `X-WIDE Prompt Input Helper` in the Manager and install it.

## Compatibility

- **ComfyUI frontend ≥ 1.3** — it needs to load `.js` from `WEB_DIRECTORY` as ES modules.
  Developed and verified against frontend 1.53.6 + ComfyUI 0.38.2 (aki-v3 portable build).
- **No Python dependencies** — the plugin is pure frontend; `nodes.py` holds empty mappings.
- **Plays well with others**: it never wraps `ComfyWidgets` and registers no nodes.
  The plain single keys do not take anything away either — `Comfy.Keybinding` treats a
  modifier-less letter as reserved for text inputs, and a real-input test on a live install
  (select a node, press `P` / `N` on the canvas) showed the built-in actions do not fire.
  For extra safety, rebind to `Ctrl+Alt+P` in Settings; it applies instantly.

### Known boundaries

- **Single-key hotkeys yield to whatever text box you are typing in**: with the caret in
  someone else's field, `P` / `N` stay in the field and only a hint pops up. That is
  deliberate — otherwise you could not type a `p` or an `n` in a prompt at all.
  Chord bindings (say `Ctrl+Alt+P`) behave the same way: never stolen inside another input.
- **"Taken in when you switch back" has to read the clipboard**: `navigator.clipboard.readText()`
  only exists in a **secure context** (`https://`, or `http://127.0.0.1` / `localhost`). When
  ComfyUI is reached over a LAN IP the browser disables the API, so the plugin tells you once to
  press `Ctrl+V` — that route works fine. Firefox forbids clipboard reads without a key press
  altogether, so use `Ctrl+V` there (again, it only says so once).
- Only **text-like** widgets are recognised (multiline and single-line text). Numbers and
  dropdowns are never written to.

## Troubleshooting

Open the browser console (F12); the plugin logs key actions under `[X-WIDE Prompt Input Helper]`.
You can also drive it directly from the console:

```js
XWidePromptHelper.open('positive')           // open a panel from code
XWidePromptHelper.describeTarget('positive') // show where it would write
XWidePromptHelper.openSettings()             // open settings
```

For chattier logs, run `localStorage.setItem('XWidePromptHelper.debug', '1')` and reload.

## Development

Frontend sources live in `web/`:

```
web/js/i18n.js           zh-CN / en-US dictionary
web/js/bridge.js         canvas bridge (find widget, write value, verify)
web/js/prompt_panel.js   the overlay itself (largest file)
web/js/prompt_helper.js  extension entry, settings/about dialogs, context menus
web/css/prompt_panel.css styles (all built on ComfyUI CSS variables)
```

The test suite has zero dependencies and runs on plain Node:

```bash
node tests/run.mjs
```

It uses a hand-written minimal DOM stub plus a ComfyUI frontend stub to exercise the whole
"hotkey → overlay → write back to widget" path end to end (312 assertions) and writes its
report to `tests/last-run.txt`. No npm install needed — it runs on plain Node (without Node,
any Electron binary works with `ELECTRON_RUN_AS_NODE=1`).

## Author

**X-WIDE**

| | |
| --- | --- |
| Repository | <https://github.com/XWIDE/comfyui-xwide-prompt-input-helper> |
| GitHub | <https://github.com/XWIDE> |
| Bilibili | <https://space.bilibili.com/374064919> |
| Registry | <https://registry.comfy.org/publishers/xwide> |

## License

GPL-3.0 — the full text is in [LICENSE](LICENSE).
