// ---------------------------------------------------------------------------
// Dialog wrapper: semantics, focus management and dismissal for every modal in the app.
//
// The three modals were plain divs over a translucent backdrop. A screen reader was
// never told a dialog had opened, focus stayed on whatever was behind it, and Tab walked
// straight out of the dialog into the page underneath — the classic "modal that isn't"
// (WCAG 4.1.2, 2.4.3, 2.4.11). Centralising it here is the point: three near-identical
// copies of focus-trap code is three chances to get one of them wrong.
//
// Design notes that are not obvious from the code:
//
//   Escape is handled HERE, not by the window-level shortcut handler in App. That
//   handler still exists and still closes these modals if the key ever reaches it, but
//   this one runs first and stops propagation, which is what allows a nested control to
//   claim Escape for itself — the table dropdown closes its own listbox, the KQL editor
//   releases its Tab capture — without the dialog vanishing underneath the user and
//   taking an unsaved draft with it. A child opts out simply by calling
//   stopPropagation() before this handler sees the event.
//
//   Tab is fully managed rather than only trapped at the two ends. Intercepting the
//   boundaries is the usual trick, but it relies on the browser to move focus for every
//   other press, which jsdom does not do, so the trap could not be tested. Every element
//   inside a dialog here is in document order with no positive tabindex, so computing
//   the next index by hand is exactly equivalent to native behaviour, and it is
//   deterministic in tests.
//
//   The backdrop closes on click, but only when both the press and the release landed on
//   the backdrop itself. Checking the click target alone still fires when a text
//   selection starts inside the dialog and the mouse is released outside it, which
//   discards a draft on what the user experienced as a drag.
// ---------------------------------------------------------------------------
import React, { useCallback, useEffect, useRef } from 'react';
import { getFocusable } from './a11y.jsx';

function Modal({ labelledBy, onClose, backdropClassName = '', className = '', style, children }) {
  const panelRef = useRef(null);
  const pressedOnBackdrop = useRef(false);

  // These modals are conditionally rendered, so mount is "opened" and unmount is
  // "closed" — no open prop is needed to drive focus.
  useEffect(() => {
    const opener = document.activeElement;
    const panel = panelRef.current;
    const target = getFocusable(panel)[0] || panel;
    target?.focus();
    return () => {
      // Restoring to a detached node silently drops focus to <body>, which is what
      // happens if the dialog's own trigger was removed while it was open.
      if (opener && document.contains(opener) && typeof opener.focus === 'function') {
        opener.focus();
      }
    };
  }, []);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;

    const focusable = getFocusable(panelRef.current);
    e.preventDefault();
    if (focusable.length === 0) {
      panelRef.current?.focus();
      return;
    }
    const current = focusable.indexOf(document.activeElement);
    // Focus on the panel itself (index -1) enters the ring at whichever end the
    // direction implies, matching what the browser would do from the container.
    const next = current === -1
      ? (e.shiftKey ? focusable.length - 1 : 0)
      : (current + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
    focusable[next].focus();
  }, [onClose]);

  const handleMouseDown = useCallback((e) => {
    pressedOnBackdrop.current = e.target === e.currentTarget;
  }, []);

  const handleClick = useCallback((e) => {
    const dismissed = e.target === e.currentTarget && pressedOnBackdrop.current;
    pressedOnBackdrop.current = false;
    if (dismissed) onClose();
  }, [onClose]);

  return (
    <div
      className={`fixed inset-0 flex bg-black/70 ${backdropClassName}`}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={className}
        style={style}
      >
        {children}
      </div>
    </div>
  );
}

export { Modal };
