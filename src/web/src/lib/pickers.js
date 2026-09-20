// The colour pickers' registry: opening one closes the others, and the session reaches the stone
// colour picker to refresh or close it (a material preset, Neutralise material, an undo).

/** Every picker's `{ close }`, so opening one closes the others. */
const editors = [];

/** The pickers the session needs by name: `{ refresh, close }` each. */
export const pickers = {};

/** Registers a picker (called by ColorSetting when it mounts); returns what to call on unmount. */
export function registerPicker(name, picker) {
  editors.push(picker);
  pickers[name] = picker;

  return () => {
    editors.splice(editors.indexOf(picker), 1);

    if (pickers[name] === picker) {
      delete pickers[name];
    }
  };
}

/** Closes every picker's sliders; opening one calls this first, itself included. */
export function closeAllPickers() {
  for (const picker of editors) {
    picker.close();
  }
}
