<script>
  // The settings dialog (2026-09-19, the user's request): File > Settings opens it, "just like
  // the gear menu" -- the same shadcn-svelte Dialog, a modal that traps focus and closes on
  // Escape. It holds the light/dark toggle, moved here from the bottom of the render settings,
  // and how many decimal places an angle shows in the instructions and in edit mode's angle ruler.
  //
  // It also holds the concave cutting profile section (T-0208), which is a placeholder: see its
  // own comment in the markup for why its controls are `disabled` rather than aria-disabled.
  //
  // Settings take effect as they are changed, and are saved as they are (the theme by
  // site/theme.js, the angle precision by lib/preferences.js), so there is no Apply: the one
  // button, Done, only closes it. The toggle is the same markup as the landing and docs pages':
  // site/theme.js handles its click by delegation, so nothing here wires it, and site/theme.css
  // lights the moon or the sun from <html data-theme>.
  import { angleDecimals, MIN_ANGLE_DECIMALS, MAX_ANGLE_DECIMALS } from '../lib/preferences.js';
  import { listeners } from '../lib/native.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as NativeSelect from '$lib/components/ui/native-select/index.js';
  import MoonIcon from '@lucide/svelte/icons/moon';
  import SunIcon from '@lucide/svelte/icons/sun';

  let isOpen = $state(false);

  /** Opens the dialog. */
  export function open() {
    isOpen = true;
  }

  // The field shows what the user typed, so clearing it to type a new number does not snap back
  // to the saved one mid-edit. Only a whole number in range is saved; on leaving the field it
  // shows the saved value again.
  let typed = $state(null);

  function onInput(event) {
    typed = event.currentTarget.value;

    if (/^\d+$/.test(typed.trim())) {
      angleDecimals.set(typed.trim());
    }
  }

  function onBlur() {
    typed = null;
  }

  // Bits UI returns focus to the element that opened a dialog, which here is a menu item that
  // has gone; the File menu's button takes it instead.
  function onCloseAutoFocus(event) {
    event.preventDefault();
    document.getElementById('menu-button-file')?.focus();
  }
</script>

<Dialog.Root bind:open={isOpen}>
  <Dialog.Content id="settings-dialog" showCloseButton={false}
    class="min-w-[280px] gap-0 rounded-md border border-border p-4 sm:max-w-[340px]"
    aria-describedby={undefined} {onCloseAutoFocus}>
    <Dialog.Title class="mb-3.5 text-sm font-bold" id="settings-dialog-title">Settings</Dialog.Title>

    <div class="flex items-center justify-between gap-4">
      <Label class="text-xs font-normal" for="theme-toggle">Light or dark mode</Label>
      <button type="button" id="theme-toggle" class="theme-toggle" data-theme-toggle
        aria-label="Light mode" aria-pressed={document.documentElement.dataset.theme === 'light'}
        data-tip="Switches the page between dark and light colors. Your choice is remembered.">
        <MoonIcon class="theme-toggle-moon" aria-hidden="true" />
        <SunIcon class="theme-toggle-sun" aria-hidden="true" />
      </button>
    </div>

    <div class="mt-3.5 flex items-center justify-between gap-4"
      data-tip="How many decimal places an angle shows in the cutting instructions and on the angle ruler in edit mode, from {MIN_ANGLE_DECIMALS} to {MAX_ANGLE_DECIMALS}. Display only: the design keeps its angles as they were. Your choice is remembered.">
      <Label class="text-xs font-normal" for="settings-angle-decimals">Angle decimal places</Label>
      <Input type="number" id="settings-angle-decimals" min={MIN_ANGLE_DECIMALS}
        max={MAX_ANGLE_DECIMALS} step="1" inputmode="numeric"
        class="h-7 w-[80px] rounded-sm px-2 text-xs md:text-xs"
        value={typed ?? String($angleDecimals)}
        {@attach listeners({ input: onInput, blur: onBlur })} />
    </div>

    <!-- Concave cutting profile (T-0208, the user: "in the settings menu can we add a concave
         cutting profile section - in the future, people can add their concave cutting profiles
         (gonna be a convex shape, probably a diamond with rounded corners or a circle) and its
         scale"). A PLACEHOLDER: every control here is really `disabled`, not merely
         aria-disabled the way the menus' inert items are -- a menu item has always been
         clickable and done nothing, but a form control that can be typed into or chosen from and
         then ignored would be a lie about the design being saved.
         The name is the confusing part, and it is the user's own and correct: the FACET is
         concave, so the tool that cuts it is convex -- a lap with a domed profile, a circle or a
         rounded-corner diamond. That is why the picker offers shapes and not curvatures, and why
         a scale sits beside it: one profile, cut at whatever size this stone needs. -->
    <div class="mt-4 border-t border-border pt-3.5" id="concave-profile-section"
      data-tip="The shape of the tool that cuts a concave facet. The tool is convex -- a dome, a circle or a diamond with rounded corners -- and the scale is how large it is cut on this stone. You will be able to add your own profiles here. Not built yet.">
      <div class="mb-2.5 text-xs font-bold text-muted-foreground">Concave cutting profile</div>

      <div class="flex items-center justify-between gap-4">
        <Label class="text-xs font-normal text-muted-foreground" for="concave-profile">Profile</Label>
        <NativeSelect.Root id="concave-profile" class="w-[140px]" selectClass="h-7 py-0 text-xs"
          disabled>
          <NativeSelect.Option value="none">None</NativeSelect.Option>
        </NativeSelect.Root>
      </div>

      <div class="mt-3 flex items-center justify-between gap-4">
        <Label class="text-xs font-normal text-muted-foreground"
          for="concave-profile-scale">Scale</Label>
        <Input type="number" id="concave-profile-scale" step="0.1" inputmode="decimal" disabled
          class="h-7 w-[80px] rounded-sm px-2 text-xs md:text-xs" value="1" />
      </div>

      <Button variant="outline" size="sm" id="concave-profile-add" disabled
        class="mt-3 w-full text-xs font-normal">Add a profile…</Button>
    </div>

    <div class="gear-dialog-actions">
      <Button size="sm" id="settings-dialog-done" onclick={() => { isOpen = false; }}>Done</Button>
    </div>
  </Dialog.Content>
</Dialog.Root>
