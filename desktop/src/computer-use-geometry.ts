/** Coordinates: the agent works in the screenshot's pixels, the system takes screen points. */

export interface DisplayInfo {
  /** Size in points (what Electron calls DIPs), origin at the top left of the primary display. */
  width: number;
  height: number;
  scaleFactor: number;
  /** Position of the display in the virtual desktop, in points. Absent = 0,0. */
  originX?: number;
  originY?: number;
}

/** A rectangle of the display, in points, relative to the display's top left corner. */
export interface Region { x: number; y: number; width: number; height: number }

export interface ImageSize { width: number; height: number }

/**
 * What the last capture showed: its image size and, for a window capture, the rectangle of the display
 * it covers. Absent region = the whole display. Later coordinates are pixels of this image.
 */
export interface Frame extends ImageSize { region?: Region }

const whole = (display: DisplayInfo): Region => ({ x: 0, y: 0, width: display.width, height: display.height });

/** The size of a screenshot: never upscaled beyond the physical resolution, ratio kept. */
export function screenshotSize(display: DisplayInfo, maxWidth: number, region?: Region): ImageSize {
  const area = region ?? whole(display);
  const physical = Math.max(1, Math.round(area.width * display.scaleFactor));
  const width = Math.max(1, Math.min(maxWidth, physical));
  return { width, height: Math.max(1, Math.round(area.height * width / area.width)) };
}

/**
 * A window's rectangle, in points of the virtual desktop, cut to the display: a window partly off
 * screen shows only its visible part, and a window elsewhere gives null. Whole points only, so the
 * crop of the capture and the conversion of the clicks agree.
 */
export function clipToDisplay(display: DisplayInfo, bounds: Region): Region | null {
  const left = Math.max(0, Math.floor(bounds.x - (display.originX ?? 0)));
  const top = Math.max(0, Math.floor(bounds.y - (display.originY ?? 0)));
  const right = Math.min(display.width, Math.ceil(bounds.x - (display.originX ?? 0) + bounds.width));
  const bottom = Math.min(display.height, Math.ceil(bounds.y - (display.originY ?? 0) + bounds.height));
  // Fewer than 8 points on a side is a minimised or hidden window, not something to look at.
  if (right - left < 8 || bottom - top < 8) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), max);

/** Image pixels → screen points, clamped on the captured area so a stray coordinate never leaves it. */
export function imageToPoints(display: DisplayInfo, frame: Frame, x: number, y: number): { x: number; y: number } {
  const area = frame.region ?? whole(display);
  return {
    x: area.x + clamp(x * area.width / frame.width, area.width - 1),
    y: area.y + clamp(y * area.height / frame.height, area.height - 1),
  };
}

/** Screen points → image pixels, for `cursor_position` and the accessibility bounds. */
export function pointsToImage(display: DisplayInfo, frame: Frame, x: number, y: number): { x: number; y: number } {
  const area = frame.region ?? whole(display);
  return {
    x: Math.round(clamp(x - (display.originX ?? 0) - area.x, area.width) * frame.width / area.width),
    y: Math.round(clamp(y - (display.originY ?? 0) - area.y, area.height) * frame.height / area.height),
  };
}

/** The frame's origin and its image pixels per point: positions are not clamped, an element may lie outside the capture. */
export function frameTransform(display: DisplayInfo, frame: Frame): { x: number; y: number; sx: number; sy: number } {
  const area = frame.region ?? whole(display);
  return { x: (display.originX ?? 0) + area.x, y: (display.originY ?? 0) + area.y, sx: frame.width / area.width, sy: frame.height / area.height };
}
