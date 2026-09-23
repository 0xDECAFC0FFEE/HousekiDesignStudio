<script>
  // One titled, foldable group: a shadcn-svelte Collapsible (Bits UI) whose trigger is the
  // group's title, so a group can be folded away to leave room for the others. It replaces the
  // <fieldset> and <legend>. Used for the render settings' groups (Material, Tracing, Lighting)
  // and, since 2026-09-22, the cutting instructions' Pavilion and Crown tables too (the user:
  // "can you use the same ui element for the pavilion/crown and the material/tracing/lighting
  // sections", then "i want to be able to fold the pavilion and crown").
  //
  // The body stays in the document while folded, only `hidden`: the renderer's hide/show of a
  // control (syncHiddenControls) finds its elements by id whatever the group's state, a colour
  // picker or a slider keeps its own state, and a tier row stays registered for the drag and
  // for scrolling to it.
  //
  //   title  the group's name, shown in capitals as the legend was
  //   id     the group's own id, where it has one
  //   open   whether the group is unfolded (bindable, so a caller can unfold it)
  //   flush  the body runs edge to edge of the group, with no padding of its own -- for a list
  //          of rows, which bring their own padding and hairlines (the tier tables)
  import * as Collapsible from '$lib/components/ui/collapsible/index.js';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';

  let { id = undefined, title, open = $bindable(true), flush = false, children } = $props();
</script>

<Collapsible.Root bind:open {id} class="panel-section {flush ? 'panel-section-flush' : ''}">
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
