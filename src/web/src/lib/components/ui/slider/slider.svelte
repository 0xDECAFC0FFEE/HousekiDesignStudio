<script>
	import { Slider as SliderPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";

	// The shadcn-svelte slider, with four additions this page needs (everything else is the
	// CLI's file, unchanged): `thumbLabel` names the thumb for a screen reader (the page's
	// rows are not <label>s around a native range input any more, so nothing else does),
	// `trackStyle` lets the colour pickers paint their hue/saturation/value gradient along the
	// track, `hideRange` drops the filled part of the track, which such a gradient replaces, and
	// `thumbClass` restyles the thumb (the pickers use a narrow bar).
	let {
		ref = $bindable(null),
		value = $bindable(),
		orientation = "horizontal",
		class: className,
		thumbLabel = undefined,
		trackStyle = undefined,
		hideRange = false,
		thumbClass = undefined,
		...restProps
	} = $props();
</script>

<!--
Discriminated Unions + Destructing (required for bindable) do not
get along, so we shut typescript up by casting `value` to `never`.
-->
<SliderPrimitive.Root
	bind:ref
	bind:value={value}
	data-slot="slider"
	{orientation}
	class={cn(
		"data-vertical:min-h-40 relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:w-auto data-vertical:flex-col",
		className
	)}
	{...restProps}
>
	{#snippet children({ thumbItems })}
		<span
			data-slot="slider-track"
			data-orientation={orientation}
			style={trackStyle}
			class={cn(
				"bg-muted rounded-full data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1 relative grow overflow-hidden data-horizontal:w-full data-vertical:h-full"
			)}
		>
			{#if !hideRange}
				<SliderPrimitive.Range
					data-slot="slider-range"
					class={cn(
						"bg-primary absolute select-none data-horizontal:h-full data-vertical:w-full"
					)}
				/>
			{/if}
		</span>
		{#each thumbItems as thumb (thumb.index)}
			<SliderPrimitive.Thumb
				data-slot="slider-thumb"
				index={thumb.index}
				aria-label={thumbLabel}
				class={cn(
					"border-ring ring-ring/50 relative size-3 rounded-full border bg-white transition-[color,box-shadow] after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 block shrink-0 select-none disabled:pointer-events-none disabled:opacity-50",
					thumbClass
				)}
			/>
		{/each}
	{/snippet}
</SliderPrimitive.Root>
