<script>
	import * as ResizablePrimitive from "paneforge";
	import { cn } from "$lib/utils.js";

	// The shadcn-svelte handle, with one change: `withHandle` draws the grip as three dots (the
	// page's own resize handle has always had them: "three dots in the middle of the two vertical
	// lines") instead of the CLI's short bar. Everything else is the CLI's file.
	let {
		ref = $bindable(null),
		class: className,
		withHandle = false,
		...restProps
	} = $props();
</script>

<ResizablePrimitive.PaneResizer
	bind:ref
	data-slot="resizable-handle"
	class={cn(
		"relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-hidden data-[direction=vertical]:h-px data-[direction=vertical]:w-full data-[direction=vertical]:after:left-0 data-[direction=vertical]:after:h-1 data-[direction=vertical]:after:w-full data-[direction=vertical]:after:translate-x-0 data-[direction=vertical]:after:-translate-y-1/2 [&[data-direction=vertical]>div]:rotate-90",
		className
	)}
	{...restProps}
>
	{#if withHandle}
		<div class="z-10 flex shrink-0 flex-col gap-[3px]" data-slot="resizable-grip">
			<span class="size-[3px] rounded-full bg-current"></span>
			<span class="size-[3px] rounded-full bg-current"></span>
			<span class="size-[3px] rounded-full bg-current"></span>
		</div>
	{/if}
</ResizablePrimitive.PaneResizer>
