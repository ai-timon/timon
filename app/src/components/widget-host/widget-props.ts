import type { ReactNode } from 'react';
import type { WidgetOrientation } from './widget-dnd';

/**
 * Common contract of every cockpit widget.
 *
 * The drag handle is provided by the rail but *placed by the widget*, in its
 * own header: if the rail laid it itself as an overlay, the drag would eat the
 * body's interactions (3D graph rotation, list scrolling, input fields).
 */
export type WidgetProps = {
  /** Whether widget configuration controls should be shown. */
  editing?: boolean;
  /** To render in the widget header, on the actions side. */
  handle: ReactNode;
  /** Classes imposed by the rail (full height, HUD surface). */
  className?: string;
  /** Replace this template in place with a newly registered widget. */
  onReplace?: (widgetId: string) => void;
  /**
   * Direction of the zone carrying the widget: `horizontal`, a line of the top
   * bar, 36 px high; `vertical`, a column. Only a widget registered with
   * `bar: true` ever receives `horizontal`.
   */
  orientation?: WidgetOrientation;
  /**
   * Paint the compact form, not the card: icons and dots only, side by side if
   * `orientation` is `horizontal`, stacked otherwise, the detail opening on
   * click. True on the top bar and in the product's two sidebars (zones declared
   * `compact`), and only for a widget registered with `bar: true` that is not in
   * a tab stack. Elsewhere (cockpit, chat columns) the widget keeps its card.
   */
  compact?: boolean;
};
