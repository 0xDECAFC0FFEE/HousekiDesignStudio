<script>
	import { Popover as PopoverPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";
	import PopoverPortal from "./popover-portal.svelte";

	// The shadcn-svelte popover content, with one edit (everything else is the CLI's file): the
	// enter and exit animation classes are removed. Bits UI keeps closing content in the
	// document until its animations have finished, two animation frames or more, which under a
	// busy render loop is a second: the editor stayed on screen after a click away and the next
	// click landed on it (kb/shadcn-svelte-ui-layer.md). Re-adding the component with
	// `--overwrite` restores them.
	let {
		ref = $bindable(null),
		class: className,
		sideOffset = 4,
		align = "center",
		portalProps,
		...restProps
	} = $props();
</script>

<PopoverPortal {...portalProps}>
	<PopoverPrimitive.Content
		bind:ref
		data-slot="popover-content"
		{sideOffset}
		{align}
		class={cn(
			"bg-popover text-popover-foreground ring-foreground/10 flex flex-col gap-2.5 rounded-lg p-2.5 text-sm shadow-md ring-1 z-50 w-72 origin-(--transform-origin) outline-hidden",
			className
		)}
		{...restProps}
	/>
</PopoverPortal>
