# Accessibility

The application is operable from the keyboard alone and passes an axe-core audit with **zero
violations** across every shell component. This page records the behaviour that is not obvious from
using it — in particular what Tab and Escape do inside the KQL editor, which will confuse anyone who
meets it without warning.

## Keyboard shortcuts

| Key | Effect |
| --- | --- |
| `Ctrl`/`Cmd` + `K` | Focus the search box |
| `Ctrl`/`Cmd` + `N` | New query |
| `Ctrl`/`Cmd` + `Shift` + `D` | Toggle the storage inspector |
| `?` | Toggle the shortcut help (ignored while typing in a field or with the editor open) |
| `Escape` | Close the topmost thing: import preview, then inspector, then editor, then help, then the search term, then the mobile sidebar |

## Tab and Escape in the KQL editor

The query box captures `Tab` to insert four spaces, which on its own is a **keyboard trap**: once
focus is in the textarea there is no key left that moves it out, and WCAG 2.1.2 is a Level A failure
with no workaround. Removing the indent was not an option either — it is the reason the field is
usable for real KQL.

The escape hatch is a mode, and it works like this:

1. `Tab` indents while the capture is on, which is the default whenever you enter the field.
2. **`Escape` releases the capture** rather than closing the dialog. The key is swallowed at the
   textarea, so the draft survives.
3. The next `Tab` then moves focus to the next control, normally.
4. A **second** `Escape` reaches the dialog and closes it, which is what a second press should do.
5. The capture comes back as soon as you type in the field again, or leave it and focus it again —
   someone who is still editing wants the indent.

The current mode is stated next to the field and wired to the textarea through `aria-describedby`,
because an invisible mode is its own accessibility problem. The two messages are:

> Tab inserts four spaces. Press Escape to release Tab, then Tab moves to the next field.

> Tab now moves to the next field. Typing here, or leaving and coming back, restores Tab indentation.

## Dialogs

The keyboard help, the query editor and the import preview were plain `div`s over a translucent
backdrop: a screen reader was never told a dialog had opened, focus stayed on whatever was behind
it, and Tab walked straight out into the page underneath. All three now render through one shared
wrapper, [`src/components/Modal.jsx`](../src/components/Modal.jsx) — three near-identical copies of
focus-trap code is three chances to get one of them wrong.

- `role="dialog"`, `aria-modal="true"` and `aria-labelledby` pointing at the dialog's own heading.
- Focus moves to the first focusable control on open and is **restored to the element that opened
  it** on close, unless that element has since been removed from the document.
- `Tab` and `Shift`+`Tab` are fully managed and cycle within the dialog. Every element inside is in
  document order with no positive `tabindex`, so computing the next index by hand is exactly
  equivalent to native behaviour — and, unlike trapping only at the two ends, it is deterministic
  under jsdom and therefore testable.
- The backdrop closes on click, but only when both the press and the release landed on it. Checking
  the click target alone discards a draft when a text selection starts inside the dialog and the
  mouse is released outside it, which the user experienced as a drag.

### Escape routing

Escape is handled **at the dialog**, not by the window-level shortcut handler in `App.jsx`. That
handler still exists and still closes these modals if the key ever reaches it, but the dialog's own
handler runs first and stops propagation. That is what lets a nested control claim Escape for
itself — the table dropdown closes its own listbox, the KQL editor releases its Tab capture, the
export menu closes only the menu — without the dialog vanishing underneath the user and taking an
unsaved draft with it. A child opts out by calling `stopPropagation()` before the dialog sees the
event.

## Menus and listboxes

- **Table selector** — a real button with `aria-haspopup`, `aria-expanded` and `aria-controls`,
  opening a `role="listbox"` with `aria-activedescendant`, arrow-key navigation, `Home`/`End`,
  Enter to select, type-to-filter, and focus returned to the trigger on close. Its Escape closes
  only the dropdown; it previously bubbled to the global handler and destroyed the editor draft.
- **Export menu** — the same pattern with `role="menu"` and `role="menuitem"`, arrow keys wrapping
  at both ends, and an Escape that closes the menu and returns focus to its button.

## Everything else

- Every icon-only button has an accessible name, and it is a name rather than the icon's own label.
- The selection control on a query card is a real checkbox, not a styled `div`.
- Toasts are announced through a live region: `role="status"` with `aria-live="polite"`, and errors
  as `role="alert"`.
- Every form field is named by a `<label>` or `aria-labelledby`, never by its placeholder alone.
- Every tabbable control carries a visible focus indicator. The shared `FOCUS_RING` in
  [`src/components/a11y.jsx`](../src/components/a11y.jsx) *replaces* the user-agent ring rather than
  removing it (WCAG 2.4.7 / 2.4.11) and is `focus-visible` rather than `focus`, so a mouse click
  does not leave a ring behind. It uses the same cyan as selection elsewhere, at roughly 11:1
  against every surface in the theme.
- **Contrast.** Secondary text sat between 2.46:1 and 4.08:1 against its surfaces where WCAG 1.4.3
  wants 4.5:1. It was lifted to roughly 7:1, with the measured before and after recorded in the
  comment beside each change.

## How it is tested

Two suites, deliberately separate, because they answer different questions:

| File | What it asserts |
| --- | --- |
| [`src/components/__tests__/a11y.test.js`](../src/components/__tests__/a11y.test.js) | axe-core over eleven component states — the dialogs, the table selector open and closed, a query card, a code block, the bulk bar, the sidebar, the toast stack and the storage inspector. **12 tests, 0 violations.** |
| [`src/components/__tests__/dialog.test.js`](../src/components/__tests__/dialog.test.js) | The keyboard behaviour axe cannot see: the focus trap in both directions, focus restoration, Escape routing, backdrop dismissal, the KQL editor's Tab capture and its release, listbox navigation, control labelling and focus visibility. **29 tests.** |

axe is a regression gate, not a certificate: it catches roughly the machine-checkable third of WCAG.
Four document-level rules (`region`, `landmark-one-main`, `page-has-heading-one`, `bypass`) are
disabled in that file because they assert things about the *page* — `App.jsx` supplies `<main>`,
`<aside>`, `<header>` and the `h1`, and a component rendered on its own to `document.body` can never
satisfy them. `color-contrast` is disabled because jsdom performs no layout and computes no cascaded
colours, so axe returns "incomplete" rather than a pass; contrast was verified in a real browser
instead, as were the zero violations, across four application states.

Run them with the rest of the suite:

```bash
npx vitest run src/components
```
