<script>
  // The tier toolbar (T-0175..T-0180, reordered and given keyboard shortcuts by T-0257): New,
  // Delete, Edit, Show/Hide, Preform, Frosted, Comments. The user's request (2026-09-18): "a
  // small menu at the bottom of the faceting instructions". Acts on the selected tier row, and
  // every button's change is recorded in the edit history; see tier_controller.js. See the CSS
  // comment above #tier-toolbar.
  //
  // T-0257's order (New, Delete, Edit, Hide, Preform, Frosted, Comments -- New and Delete swapped
  // with Edit from T-0175's original New, Edit, Delete, Hide) is two DOM groups, `.tier-toolbar-
  // row`, of four and three: at a narrow pane the CSS stacks them as two rows exactly that split,
  // never any other one (see the CSS comment); at a wide pane the same markup reads as one row of
  // seven, in this same left-to-right order. See instructions.css.
  //
  // Backspace/Delete and Enter (T-0257) do what the Delete and Edit buttons do, from anywhere on
  // the page a text field isn't focused (App.svelte's onkeydown, and TierRow.svelte's own Enter
  // once a row is already selected) -- see tier_controller.js's TOOL_TIPS for where that is said
  // in the tooltips below.
  //
  // Each BUTTON carries its own data-tip (the user asked for "tooltips for each button"); the bar
  // and the pane carry none, because the tooltip takes the OUTERMOST data-tip ancestor. Inactive
  // buttons are `aria-disabled`, not `disabled`, so their tooltips still show.
  //
  // shadcn-svelte's Button for the two actions and its Toggle for the two that switch a state
  // on the tier (Preform and Frosted, whose `aria-pressed` Bits UI keeps). The toggles are
  // controlled: the tier's own flag, read from `$toolbar`, is the pressed state, so a click on an
  // inactive one (which the action ignores) can never flip the button on its own.
  import { toolbar, toolbarActions } from '../lib/tier_controller.js';
  import { openComments } from '../lib/comments.js';
  import { enterEditMode, editSelectedTier } from '../lib/edit_mode.js';
  import { cutting } from '../lib/cutting_assistant_mode.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Toggle } from '$lib/components/ui/toggle/index.js';

  // The look every button in the bar shares: small, one line, filling its share of the row.
  // `aria-disabled:hover:bg-transparent!` (2026-09-22) stops an inactive button's hover from
  // showing at all: the Button and Toggle components' own hover (`dark:hover:bg-input/50`, since
  // this page is always in the `dark:` variant) knows nothing about `aria-disabled` (only a real
  // `disabled` attribute silences a hover, which these buttons deliberately do not use, so their
  // tooltips keep showing -- see the file header), and a control that visibly highlights on
  // hover but does nothing when clicked is exactly the kind of thing "disabled things must stay
  // looking disabled" rules out. The trailing `!` (Tailwind v4's `important` modifier) is load-
  // bearing, not decoration: `aria-disabled:hover:bg-transparent` alone LOSES the cascade to
  // `dark:hover:bg-input/50` even though it looks more specific on paper (an extra attribute
  // selector) -- checked with `CSS.getMatchedStylesForNode` over CDP, hovering an inert "New"
  // still read back the CLI's 30%-panel-edge tint, not transparent, and `!important` was the fix
  // that was actually confirmed to work, not merely reasoned about.
  // One flex basis for every button, not each its own text's width (T-0226), so the buttons on
  // each line of the wrapping bar come out equally wide; see #tier-toolbar in instructions.css.
  const TOOL = 'tier-tool h-7 min-w-0 flex-[1_1_58px] px-1.5 text-[12px] font-normal aria-disabled:cursor-default aria-disabled:opacity-45 aria-disabled:hover:bg-transparent!';

  // The Toggles' off state, matching the Buttons' outline variant (the Toggle's own outline is
  // transparent, which in dark mode left Preform and Frosted darker than New/Delete/Hide).
  const OFF = 'border-border bg-background hover:bg-muted dark:bg-input/30 dark:border-input dark:hover:bg-input/50';

  // New enters edit mode on the tier it returns (null while inactive). Edit's own version of
  // this is edit_mode.js's editSelectedTier, shared with the Enter shortcut (App.svelte) and a
  // tier row's own Enter (TierRow.svelte), so all three do exactly the same thing (T-0257).
  function onnew() {
    const tier = toolbarActions.new();

    if (tier) {
      enterEditMode(tier);
    }
  }
</script>

<!-- Gone altogether while the cutting assistant is open (T-0234, the user: "we leave the cutting
     instructions on the screen without the buttons at the bottom"): that mode changes nothing, so
     there is nothing for them to do. `display: none` rather than unmounting, so the pane's
     ResizeObserver on this bar (InstructionsPane) sees it go to no height and gives the rows the
     room back. -->
<div id="tier-toolbar" role="toolbar" aria-label="Tier tools" aria-controls="tier-tables"
  style:display={$cutting.open ? 'none' : null}>
  <!-- The first four (T-0257): New, Delete, Edit, Hide. Grouped in markup so the CSS can either
       stack this whole group above the second one (a narrow pane) or dissolve the grouping
       entirely (a wide one, one row of seven) -- see instructions.css. -->
  <div class="tier-toolbar-row">
    <!-- New copies the selected tier and Edit edits it; both then enter edit mode (T-0181,
         T-0193). -->
    <Button variant="outline" size="xs" class={TOOL} id="tier-tool-new"
      aria-disabled={String(!$toolbar.new.active)} aria-label="New tier, copied from the selected one"
      data-tip={$toolbar.new.tip} onclick={onnew}>New</Button>
    <Button variant="outline" size="xs" class={TOOL} id="tier-tool-delete"
      aria-disabled={String(!$toolbar.delete.active)} aria-label="Delete the selected tier"
      data-tip={$toolbar.delete.tip} onclick={toolbarActions.delete}>Delete</Button>
    <Button variant="outline" size="xs" class={TOOL} id="tier-tool-edit"
      aria-disabled={String(!$toolbar.edit.active)} aria-label="Edit the selected tier"
      data-tip={$toolbar.edit.tip} onclick={editSelectedTier}>Edit</Button>
    <!-- Reads "Hide" for a shown tier and "Show" for a hidden one. -->
    <Button variant="outline" size="xs" class={TOOL} id="tier-tool-visibility"
      aria-disabled={String(!$toolbar.visibility.active)} aria-label={$toolbar.visibility.ariaLabel}
      data-tip={$toolbar.visibility.tip} onclick={toolbarActions.visibility}>{$toolbar.visibility.label}</Button>
  </div>
  <!-- The second three: Preform, Frosted, Comments. -->
  <div class="tier-toolbar-row">
    <Toggle variant="outline" size="sm" class="{TOOL} {OFF} data-[state=on]:bg-primary/20 data-[state=on]:border-primary" id="tier-tool-preform"
      bind:pressed={() => $toolbar.preform.pressed, () => toolbarActions.preform()}
      aria-disabled={String(!$toolbar.preform.active)} aria-label="Preform tier"
      data-tip={$toolbar.preform.tip}>Preform</Toggle>
    <Toggle variant="outline" size="sm" class="{TOOL} {OFF} data-[state=on]:bg-primary/20 data-[state=on]:border-primary" id="tier-tool-frosted"
      bind:pressed={() => $toolbar.frosted.pressed, () => toolbarActions.frosted()}
      aria-disabled={String(!$toolbar.frosted.active)} aria-label="Frosted tier"
      data-tip={$toolbar.frosted.tip}>Frosted</Toggle>
    <!-- Comments (2026-09-19) is the one button here that acts on the DESIGN rather than the
         selected tier, so it is active whenever a design is loaded, with no selection needed. It
         opens the dialog and nothing else; the dialog itself reads and writes the design. -->
    <Button variant="outline" size="xs" class={TOOL} id="tier-tool-comments"
      aria-disabled={String(!$toolbar.comments.active)} aria-label="Header and footer comments"
      data-tip={$toolbar.comments.tip}
      onclick={() => { if ($toolbar.comments.active) { openComments(); } }}>Comments</Button>
  </div>
</div>
