// ---------------------------------------------------------------------------
// Shared accessibility primitives.
//
// Two things live here because more than one component needs them and drift between
// copies is what produces the "most of the app is accessible" failure mode:
//
//   FOCUS_RING — the visible focus indicator. The palette is dark and several controls
//     are transparent icon buttons, where the user-agent focus ring is close to
//     invisible. This replaces it rather than removing it (WCAG 2.4.7 / 2.4.11), and it
//     is focus-VISIBLE rather than focus so a mouse click does not leave a ring behind.
//     The colour is the same cyan used for selection elsewhere, which sits at roughly
//     11:1 against every surface in the theme.
//
//   getFocusable — the tab order of a subtree, used by the dialog focus trap and by the
//     tests that assert every reachable control carries an indicator. Deliberately does
//     NOT filter on visibility: jsdom performs no layout, so offsetParent is null for
//     everything and a visibility filter would empty the list under test while working
//     in the browser. Nothing in this app renders a focusable element it means to hide
//     — hidden UI is conditionally rendered, not display:none'd — so the cheap checks
//     below are sufficient and behave identically in both environments.
//
// The class string is a literal so the Tailwind CLI's content scan finds it; see the
// note in tailwind.config.js about computed class names.
// ---------------------------------------------------------------------------

const FOCUS_RING = 'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00d4ff]';

// [tabindex] is matched unqualified and then filtered on the resolved tabIndex, which
// covers tabindex="-1" without needing a second attribute selector.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable="true"]',
  '[tabindex]',
].join(', ');

/**
 * Elements inside `root` that are in the tab order, in document order.
 * `root` itself is never included, so a dialog panel carrying tabIndex={-1} can be the
 * container and the fallback focus target at the same time.
 */
function getFocusable(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (el) =>
      el.tabIndex >= 0 &&
      !el.hasAttribute('inert') &&
      el.getAttribute('aria-hidden') !== 'true' &&
      !el.closest('[inert], [aria-hidden="true"]'),
  );
}

export { FOCUS_RING, FOCUSABLE_SELECTOR, getFocusable };
