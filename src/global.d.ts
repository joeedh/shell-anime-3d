import type { AppState } from "./core/app";

declare global {
  /** The running app; set in core/app.ts start(). Debugging and undo hooks use it. */
  var _appstate: AppState;

  /** Requests a viewport redraw on the next animation frame. */
  var redraw_all: () => void;

  interface Window {
    _appstate: AppState;
    redraw_all: () => void;
    haveNwjs?: boolean;
  }
}

export {};
