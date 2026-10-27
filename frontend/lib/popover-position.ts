/**
 * Pure placement for floating panels (model picker): fixed coordinates computed
 * from the trigger rect so the panel never overflows the viewport.
 */

export interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PopoverInput {
  trigger: RectLike;
  viewport: { width: number; height: number };
  /** Preferred panel width (clamped to the viewport). */
  width: number;
  /** Natural (unclamped) panel height, if known; used to pick a side. */
  contentHeight?: number;
  prefer?: "up" | "down";
  /** Minimum distance to every viewport edge. */
  margin?: number;
  /** Distance between trigger and panel. */
  gap?: number;
  /** Below this viewport width the panel becomes a full-width bottom sheet. */
  sheetBelow?: number;
  /** Upper bound for maxHeight in popover mode. */
  maxHeightCap?: number;
}

export type PopoverPosition =
  | { mode: "sheet"; left: 0; width: number; bottom: 0; maxHeight: number }
  | {
      mode: "popover";
      placement: "up" | "down";
      left: number;
      width: number;
      /** Set for "down" (top edge anchored). */
      top?: number;
      /** Set for "up" (bottom edge anchored, distance from the viewport bottom). */
      bottom?: number;
      maxHeight: number;
    };

export function computePopoverPosition(input: PopoverInput): PopoverPosition {
  const { trigger, viewport } = input;
  const margin = input.margin ?? 12;
  const gap = input.gap ?? 8;
  const sheetBelow = input.sheetBelow ?? 640;
  const vw = Math.max(0, viewport.width);
  const vh = Math.max(0, viewport.height);

  if (vw < sheetBelow) {
    return { mode: "sheet", left: 0, width: vw, bottom: 0, maxHeight: Math.max(0, Math.round(vh * 0.85)) };
  }

  const width = Math.max(0, Math.min(input.width, vw - 2 * margin));
  const maxLeft = vw - margin - width;
  const left = Math.max(margin, Math.min(trigger.left, maxLeft));

  // Clamp the trigger into the viewport first (it may be partially scrolled away).
  const tTop = Math.max(0, Math.min(trigger.top, vh));
  const tBottom = Math.max(0, Math.min(trigger.bottom, vh));
  const spaceBelow = Math.max(0, vh - tBottom - gap - margin);
  const spaceAbove = Math.max(0, tTop - gap - margin);
  const need = input.contentHeight ?? Infinity;
  const prefer = input.prefer ?? "down";
  const other = prefer === "down" ? "up" : "down";
  const space = (side: "up" | "down") => (side === "down" ? spaceBelow : spaceAbove);

  let placement: "up" | "down";
  if (space(prefer) >= need) placement = prefer;
  else if (space(other) >= need) placement = other;
  else placement = space(prefer) >= space(other) ? prefer : other;

  const maxHeight = Math.floor(Math.min(space(placement), input.maxHeightCap ?? Infinity));
  return placement === "down"
    ? { mode: "popover", placement, left, width, top: tBottom + gap, maxHeight }
    : { mode: "popover", placement, left, width, bottom: vh - tTop + gap, maxHeight };
}
