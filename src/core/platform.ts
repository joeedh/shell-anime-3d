// NW.js can't resolve bare ES-module specifiers such as "fs", so Node is reached through
// the page's global require. File dialogs use NW.js's <input type="file"> extensions.

type NodeFs = typeof import("fs");

/** Node's fs module, or undefined outside NW.js (e.g. a plain browser). */
export function nodeFs(): NodeFs | undefined {
  const req = (globalThis as { require?: (m: string) => unknown }).require;
  return req ? (req("fs") as NodeFs) : undefined;
}

function runFileInput(setup: (input: HTMLInputElement) => void): Promise<string | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";
    setup(input);
    input.addEventListener("change", () => {
      // NW.js exposes the native path as File.path; for nwsaveas it is input.value
      const file = input.files?.[0] as (File & { path?: string }) | undefined;
      resolve(file?.path || input.value || undefined);
      input.remove();
    });
    input.addEventListener("cancel", () => {
      resolve(undefined);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** Native open dialog; resolves to a path, or undefined if cancelled. */
export function pickOpenPath(accept: string) {
  return runFileInput((input) => {
    input.accept = accept;
  });
}

/** Native save dialog; resolves to a path, or undefined if cancelled. */
export function pickSavePath(defaultName: string, accept: string) {
  return runFileInput((input) => {
    input.accept = accept;
    input.setAttribute("nwsaveas", defaultName);
  });
}
