# Studio — change the site by pointing at it

Studio is a local editing mode for the Numax site. You open the real site on
your own machine, click things, drag things, change how they look, and press
Save. It writes the change into the real `index.html`.

It only exists on your machine. The live site never loads any of this.

## Starting it

Double-click **`Studio.cmd`** in this folder. It opens
<http://localhost:8731/> with the editing bar along the bottom.

If it says the port is busy, you have an old preview server still running
from a previous session — close that window and try again.

To stop Studio, close the black window it opened.

## The bar along the bottom

| Button | What it does |
|---|---|
| **Select** | Click anything on the page to open its settings panel. |
| **Move** | Drag a box to a different position among the things next to it. |
| **Note** | Click a spot and describe what you want there. Goes to Claude. |
| **Open app view** | Jumps past the sign-in screen so you can work on the inner screens. |
| **Save** | Writes everything to the real file. |
| **Undo last save** | Puts the file back exactly as it was before your last Save. |

Press **Escape** to drop out of any mode and use the site normally again.

## What the settings panel gives you

Size, spacing, text (size, weight, spacing, alignment, colour), background,
borders, corners, shadow, transparency, and how a box arranges the things
inside it. Plus **Hide this**, and — when you have picked a piece of plain
text — a box to retype the wording.

Two things worth knowing:

- **"Just this one" vs "All N like it".** The second one changes every card,
  chip or button of that kind at once. That is usually what you want when
  something looks wrong everywhere.
- **The breadcrumbs at the top of the panel.** Clicking usually grabs
  something small, like the text inside a card. The breadcrumbs walk you
  outwards to the card itself.

## When Studio tells you it can't

- **"pinned by styling written directly into this element"** — that setting
  is written into the page's markup, which a stylesheet cannot override.
  Use **Note** to ask for it.
- **"This part is drawn by the app while it runs"** — you can restyle it
  freely, but its wording and position come from code. Use **Note**.
- **"This element also has narrow-screen styling"** — the site has separate
  rules for narrow windows. What you set here applies at *every* width and
  will win over those, so check a narrow window before you commit to it.

## Where your changes go

Everything Studio styles lands in one clearly-marked block at the bottom of
the stylesheet inside `index.html`. That block is the whole record — delete
it and every visual tweak disappears at once, cleanly.

Wording changes and moves are edited straight into the markup where they
belong, so they read as if they were always written that way.

Before every Save, Studio copies the current `index.html` into
`studio/backups/`. **Undo last save** restores the newest of those. The last
40 are kept. They are not committed to git — git itself is the longer
history.

## Notes you pin

They collect in `studio/requests.md`, each one recording what you clicked and
what you asked for. Anything needing real code — a new button that actually
does something, a behaviour change, a new screen — goes here, and Claude
picks it up from this folder.
