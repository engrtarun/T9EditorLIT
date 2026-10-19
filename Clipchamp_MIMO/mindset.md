# mindset.md — MIMO

> Cell 5 of `resource_Clipchamp/desing4use.ipynb` asks each agent to write down
> *how* it is using the material it was handed, and calls it an exam. This is
> my answer. It is written for the next agent picking this up, and for the
> user, who has to be able to tell whether the material was actually used or
> just skimmed.

---

## 1. What I was given, and how I actually consumed it

I did **not** open the 69 KB React captures and eyeball them. A 69 KB JSX blob
is unreadable on sight, so I dumped each cell to a temp `.tsx` and ran two
mechanical passes over it:

1. a regex pass that pulls out `data-testid`, `aria-label`, `title`,
   `fui-*` class names and inline `style` objects — the *contract* of the
   component, which is what matters for a clone;
2. an outline pass that walks the tag tree and prints an indented skeleton of
   `role` / `testid` / `aria` / `fui-*` — the *shape*, without the noise of
   fifty hashed CSS-module classes.

That is how the rename menu's exact row order, the timeline toolbar's four
`data-testid`s and the full-screen preview's transport bar got recovered
exactly, rather than approximately. Reproducing "roughly the same" UI is the
failure mode of cloning something; the test-ids are the part that is
*checkable*, so they are the part I extracted first.

The screenshots (`attachment:image.png` in cells 3, 9, 11, 13, 17) were
extracted from the notebook's base64 attachments and read directly. The
screenshots gave me **layout and spacing**; the DOM captures gave me **wording
and semantics**. Neither alone is enough — a screenshot cannot tell you that a
row is `data-testid="rename-button"`, and a DOM capture cannot tell you the
toolbar is 129.6 × 33.2 px docked bottom-right.

The screen recording `clipchamp_OBSrecord.mp4` was treated as the *behaviour*
source: the DOM captures are single instants, and only the recording shows
what animates, what disables, and what appears after what.

## 2. The decisions I made, and why

**Dark theme, three palettes, one token namespace.** The user's prototype
(`clipchamp_test.html`) is dark; so is every screenshot they sent. Rather than
fork the CSS, all three themes write the *same* `--color-cc-*` variables and
`<html data-theme>` picks the winner. The payoff is that no component knows
which theme is up — which is the only way a theme switch can be a 3-line
change instead of a 40-file one.

**The purple ramp is role-based, not a lightness ramp.** A naive ramp makes
"accent purple" carry white text at ~3.5:1, which fails AA. So `purple` is
reserved for focus rings and the rail indicator (never text), `btn` is the
version contrast-checked against white, and `link` is the accent that is
allowed to be text. Every keep/cut/review pair was checked as a pair, because
those two colours are always seen side by side, never alone.

**Unlayered CSS for the menus.** Tailwind emits its theme into `@layer theme`;
consumption rules placed *unlayered* outrank every layer, so a `.cc-menu`
class cannot be silently beaten by a utility on the same element. This is
subtle, so it is commented where it is written.

**One `keydown` listener for the whole shell.** Every component adding its own
window listener is how you end up with three handlers for `Space`. Instead
there is one table (`BINDINGS`) and a registry; components *bind* an action
and the effect's cleanup unbinds it. The same table then generates the
`Ctrl + /` cheat sheet, which means the sheet cannot lie about what the app
does — a shortcut that is not in the table cannot be pressed, and one that is
in it is documented for free.

**Escape has exactly one owner at a time.** Stage uses it for "leave full
screen", the cheat sheet uses it to close. Rather than special-casing, the
sheet *registers* its Escape binding only while open, and unregisters on
close. Whoever owns it owns it alone.

**Full screen is CSS, not a second `<video>`.** The naive implementation
mounts a second player element: two decoders, and a playback position to
re-sync when you come back. Instead the existing canvas wrapper gets
`fixed inset-0`. One element, one decoder, nothing to re-sync. It also stays
inside the app, which is safer than `requestFullscreen()` in a WebView, where
a refused request can strand the window.

**Drag & drop uses Tauri's native event, not HTML5 DnD.** This is the one
decision I would defend hardest. WebView2 does not expose a dropped file's
absolute path on `DataTransfer`, and the tempting workaround — read the blob
and guess — means pulling a 5 GB file into the heap. That is the zero-RAM rule
from AGENTS.md §1, broken outright, by a *UI convenience*. So
`getCurrentWebview().onDragDropEvent()` hands back real paths, the file stays
on disk, and ffprobe reads only the header. The drag payload is a path,
never bytes, for the same reason.

**Everything global lives outside `{#key}`.** Mode isolation is the product's
core idea, and it is also a trap: anything mounted inside a `{#key}` dies on
the next switch. The drop listener, the key dispatcher and the cheat sheet
are all mounted outside every keyed block, with a comment saying why, because
otherwise the next agent will move them into a panel "for tidiness" and Space
will go dead on returning from the home screen.

## 3. What I deliberately did not do

- **No clip objects on the timeline.** Real editors keep a list of clips; that
  is a second in-memory copy of the project's structure. Here the timeline is
  a *view over the source* plus a transcript — "split" marks a boundary in the
  transcript rather than creating two objects. Cheaper, and it is what makes
  the zero-RAM claim true rather than aspirational.
- **No icon library.** AGENTS.md §2 bans them, and a handful of inline SVG
  paths is smaller than the import.
- **No backend.** The cloud, Gemini and Groq rows are real menu entries that
  lead to a real Settings tab, but they do not call anything yet. Fake
  progress bars are worse than an honest "not connected".
- **Not `requestFullscreen()`.** See §2.

## 4. What I got wrong and fixed

- Wrote `.cc-shell { color-scheme: light }` into the dark theme, which made
  Chrome paint light scrollbars over a dark panel. Fixed by inheriting from
  `<html>`, where the theme actually decides.
- The media panel had a "…" button nested inside a load button — invalid HTML,
  and it makes the row untabbable. Split into an outer container plus two
  sibling buttons.
- Claimed `authorized` where the Rust command returns `authorised`. Exactly the
  kind of drift the ipc/types mirror is meant to prevent; caught by
  `svelte-check`, which is why `npm run verify:fast` is not optional.

## 5. What I would tell the next agent

1. Re-read `desing4use.ipynb` **and** `desing4use_part2.ipynb` at the start of
   every session. Cell 20 moved all future material to the second file, so
   reading only the first one now means silently working from stale inputs.
2. Read `docs/CLIPCHAMP_IPYNB_FINDINGS.md` before touching the UI. It is the
   inventory the user explicitly asked for, precisely so that "I didn't see
   that cell" stops being a possible excuse.
3. `resource_Clipchamp/NOT.mp4` is the test video (cell 19). Use it.
4. Run `npm run verify:fast` before you say you are done. It has caught real
   bugs every single time.
5. Cell 16 asks for a side-by-side screenshot comparison against real
   Clipchamp. That is still open, and it is the only way to answer "is it 90%
   similar?" with evidence instead of a claim.
