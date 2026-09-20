<script>
  // One titled group of settings in the right-hand panel (Material, Tracing, Lighting, View): a
  // shadcn-svelte Collapsible (Bits UI) whose trigger is the group's title, so a group can be
  // folded away to leave room for the others. It replaces the <fieldset> and <legend>.
  //
  // The body stays in the document while folded, only `hidden`: the renderer's hide/show of a
  // control (syncHiddenControls) finds its elements by id whatever the group's state, and a
  // colour picker or a slider keeps its own state.
  //
  //   title  the group's name, shown in capitals as the legend was
  //   id     the group's own id, where it has one
  import * as Collapsible from '$lib/components/ui/collapsible/index.js';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';

  let { id = undefined, title, children } = $props();

  let open = $state(true);
</script>

<Collapsible.Root bind:open {id} class="panel-section">
  <Collapsible.Trigger class="panel-section-title group">
    <span>{title}</span>
    <ChevronDownIcon class="size-3.5 transition-transform group-data-[state=closed]:-rotate-90" />
  </Collapsible.Trigger>
  <!-- Hidden the moment the group is folded: Bits UI would hide the content only once its
       animations have finished (two animation frames later, which under a busy render loop is
       noticeable), and there are none. -->
  <Collapsible.Content class="panel-section-body">
    {#snippet child({ props, open: isOpen })}
      <div {...props} hidden={!isOpen}>
        {@render children()}
      </div>
    {/snippet}
  </Collapsible.Content>
</Collapsible.Root>
