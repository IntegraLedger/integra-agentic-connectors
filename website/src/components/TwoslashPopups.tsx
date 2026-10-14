"use client";

import { useEffect } from "react";

/** How long a pointer rests on a trigger before its popup opens, and leaves before it closes, in ms. */
const OPEN_DELAY = 200;
const CLOSE_DELAY = 100;

/** What sequential keyboard focus can reach. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** The trigger button an event happened on: a `.twoslash-hover` that names its popup by number. */
function triggerOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(".twoslash-hover[data-popup]") : null;
}

/**
 * Shows the Twoslash popup of each trigger button on the page, one at a time, below its trigger (above it
 * when there is no room below). The popups' HTML is fetched from `src` when a reader first points at,
 * focuses or clicks a trigger, and again after a failed fetch. A popup opens on hover, keyboard focus or click,
 * and closes when the pointer (or, for one keyboard focus opened, the focus) leaves both it and its trigger, on
 * a second click, on a click elsewhere, or on Escape. A trigger the pointer crosses on its way into the shown
 * popup does not replace it. Enter or Space on a trigger moves focus into its popup; Tab past the popup's last
 * focusable element closes it and moves on to the element after the trigger, and Shift+Tab out of it returns to the
 * trigger with the popup still shown. Escape from inside the popup closes it and returns focus to the trigger.
 */
export function TwoslashPopups({ src }: { src: string }) {
  useEffect(() => {
    let popups: Promise<string[]> | undefined;
    const load = () =>
      (popups ??= fetch(src)
        .then((response) => {
          if (!response.ok) throw new Error(`${src}: ${response.status}`);
          return response.json() as Promise<string[]>;
        })
        .catch((e: unknown) => {
          popups = undefined;
          throw e;
        }));

    const popup = document.createElement("div");
    popup.id = "twoslash-popup";
    popup.className = "fd-twoslash-popover twoslash-popover";
    popup.setAttribute("role", "dialog");
    popup.tabIndex = -1;
    popup.hidden = true;
    document.body.append(popup);

    /** The trigger whose popup is shown, the one a pending open is for, and whether keyboard focus holds it open. */
    let shown: HTMLElement | undefined;
    let wanted: HTMLElement | undefined;
    let byFocus = false;
    /** A trigger that Escape is returning focus to, which that focus does not reopen. */
    let refocused: HTMLElement | undefined;
    let openTimer: number | undefined;
    let closeTimer: number | undefined;

    const place = (trigger: HTMLElement) => {
      const box = trigger.getBoundingClientRect();
      const width = popup.offsetWidth;
      const height = popup.offsetHeight;
      const viewport = document.documentElement;
      const left = Math.max(8, Math.min(box.left + box.width / 2 - width / 2, viewport.clientWidth - width - 8));
      const below = box.bottom + 4 + height <= viewport.clientHeight || box.top - 4 - height < 0;
      popup.style.left = `${left + window.scrollX}px`;
      popup.style.top = `${(below ? box.bottom + 4 : box.top - 4 - height) + window.scrollY}px`;
    };

    const close = () => {
      window.clearTimeout(openTimer);
      window.clearTimeout(closeTimer);
      wanted = undefined;
      shown?.setAttribute("aria-expanded", "false");
      shown = undefined;
      popup.hidden = true;
    };

    /** Shows a trigger's popup; resolves to whether it is shown. */
    const open = async (trigger: HTMLElement, focus = false): Promise<boolean> => {
      window.clearTimeout(openTimer);
      window.clearTimeout(closeTimer);
      wanted = trigger;
      let html: string | undefined;
      try {
        html = (await load())[Number(trigger.dataset.popup)];
      } catch {
        if (wanted === trigger) wanted = shown;
        return false;
      }
      if (wanted !== trigger || html === undefined) return false;
      shown?.setAttribute("aria-expanded", "false");
      shown = trigger;
      byFocus = focus;
      popup.innerHTML = html;
      popup.setAttribute("aria-label", trigger.textContent ?? "");
      popup.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      trigger.setAttribute("aria-controls", popup.id);
      place(trigger);
      return true;
    };

    /** Whether a node is inside the shown popup or its trigger. */
    const inside = (node: EventTarget | null) =>
      node instanceof Node && (popup.contains(node) || (shown !== undefined && shown.contains(node)));

    const scheduleClose = () => {
      window.clearTimeout(closeTimer);
      closeTimer = window.setTimeout(close, CLOSE_DELAY);
    };

    /** Drops a pending open, keeping the shown popup. */
    const keepShown = () => {
      window.clearTimeout(openTimer);
      wanted = shown;
    };

    /** Focuses the element keyboard focus reaches after the trigger, outside the popup. */
    const focusAfter = (trigger: HTMLElement) => {
      const all = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (e) => !popup.contains(e) && e.getClientRects().length > 0,
      );
      (all[all.indexOf(trigger) + 1] ?? trigger).focus();
    };

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      if (popup.contains(event.target as Node)) {
        window.clearTimeout(closeTimer);
        keepShown();
        return;
      }
      const trigger = triggerOf(event.target);
      if (!trigger) return;
      load().catch(() => undefined);
      window.clearTimeout(closeTimer);
      if (trigger === shown) {
        keepShown();
        return;
      }
      if (trigger === wanted) return;
      window.clearTimeout(openTimer);
      wanted = trigger;
      openTimer = window.setTimeout(() => void open(trigger), OPEN_DELAY);
    };
    const onPointerOut = (event: PointerEvent) => {
      if (event.pointerType === "touch" || inside(event.relatedTarget)) return;
      const trigger = triggerOf(event.target);
      if (trigger && trigger === wanted && trigger !== shown) keepShown();
      if (shown && (inside(event.target) || trigger)) scheduleClose();
    };
    const onClick = (event: MouseEvent) => {
      const trigger = triggerOf(event.target);
      if (trigger) {
        // Enter or Space (a click with no pointer) moves focus into the popup; a pointer click toggles it.
        if (event.detail === 0) {
          void (trigger === shown ? Promise.resolve(true) : open(trigger, true)).then((ok) => {
            if (!ok || shown !== trigger) return;
            byFocus = true;
            popup.focus();
          });
        } else if (trigger === shown) close();
        else void open(trigger);
      } else if (shown && !popup.contains(event.target as Node)) {
        close();
      }
    };
    // A click focuses its trigger too; only keyboard focus opens a popup here, and a click opens it in onClick.
    const onFocusIn = (event: FocusEvent) => {
      const trigger = triggerOf(event.target);
      if (trigger && trigger !== shown && trigger !== refocused && trigger.matches(":focus-visible")) {
        void open(trigger, true);
      }
    };
    // A popup that keyboard focus opened closes when focus leaves it; one the pointer opened, when the pointer does.
    const onFocusOut = (event: FocusEvent) => {
      if (shown && byFocus && !inside(event.relatedTarget)) scheduleClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && shown) {
        const trigger = shown;
        // Read before close(): hiding the popup moves focus out of it.
        const focusInPopup = popup.contains(document.activeElement);
        close();
        if (focusInPopup) {
          // focus() runs the focusin handler before it returns.
          refocused = trigger;
          trigger.focus();
          refocused = undefined;
        }
        return;
      }
      if (event.key === "Tab" && shown && popup.contains(document.activeElement)) {
        const items = [...popup.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const active = document.activeElement;
        const leaving = event.shiftKey
          ? active === popup || active === items[0]
          : items.length === 0 || active === items[items.length - 1];
        if (!leaving) return;
        event.preventDefault();
        const trigger = shown;
        if (event.shiftKey) {
          // Back to the trigger, whose popup stays shown while focus is on it.
          byFocus = true;
          trigger.focus();
        } else {
          close();
          focusAfter(trigger);
        }
      }
    };

    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("click", onClick);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      close();
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("click", onClick);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKeyDown);
      popup.remove();
    };
  }, [src]);
  return null;
}
