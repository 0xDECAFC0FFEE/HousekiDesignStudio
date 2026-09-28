<script>
	import { Slider as SliderPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";

	// The shadcn-svelte slider, with six additions this page needs (everything else is the
	// CLI's file, unchanged): `thumbLabel` names the thumb for a screen reader (the page's
	// rows are not <label>s around a native range input any more, so nothing else does),
	// `trackStyle` lets the colour pickers paint their hue/saturation/value gradient along the
	// track, `hideRange` drops the filled part of the track, which such a gradient replaces,
	// `thumbClass` restyles the thumb (the pickers use a narrow bar), and (2026-09-22, the user:
	// "sliders highlight on hover, and highlight more while being clicked/dragged") the thumb and
	// track below now carry TWO tiers of highlight instead of one: a hover ring one size smaller
	// than the drag ring, and the drag ring only while Bits UI's own `data-active` is set --
	// Bits UI's slider moves the thumb from document-level pointer handlers, not
	// `setPointerCapture`, so a plain `active:` (CSS `:active`) ring would drop out the moment a
	// fast drag's pointer leaves the thumb's own box; `data-active` (mapped by this page's own
	// `data-active` custom variant in tailwind.css) does not, since Bits UI sets and clears it
	// itself from the drag's start and end rather than from where the pointer happens to be.
	// `group/slider` on the root and `group-has-data-[active]/slider:` on the track are what let
	// the TRACK react to a drag that is happening on the THUMB, a sibling it cannot select
	// directly.
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

	// The thumbs, one per value, worked out here rather than taken from Bits UI's snippet
	// argument (a sixth addition, 2026-09-28). That argument is one derived object holding the
	// thumbs AND a tick for every step of the range -- 361 for a rotation slider, 2,001 for the
	// refractive index -- and reading any part of it recomputes all of it on every change of
	// value. Placing each tick asks the slider for its thumb and track widths, a forced layout of
	// the page per tick. Profiled on an M1 Pro, that was most of what made dragging the stone
	// stall: the rotation sliders follow the drag, and each follow cost hundreds of layouts. This
	// page draws no ticks, so it never reads them.
	const thumbIndices = $derived(Array.isArray(value) ? value.map((_, index) => index) : [0]);
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
		"group/slider data-vertical:min-h-40 relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:w-auto data-vertical:flex-col",
		className
	)}
	{...restProps}
>
	{#snippet children()}
		<span
			data-slot="slider-track"
			data-orientation={orientation}
			style={trackStyle}
			class={cn(
				"bg-muted rounded-full data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1 relative grow overflow-hidden data-horizontal:w-full data-vertical:h-full transition-shadow hover:ring-1 hover:ring-primary/50 group-has-data-[active]/slider:ring-2 group-has-data-[active]/slider:ring-primary"
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
		{#each thumbIndices as index (index)}
			<SliderPrimitive.Thumb
				data-slot="slider-thumb"
				{index}
				aria-label={thumbLabel}
				class={cn(
					"border-ring ring-ring/50 relative size-3 rounded-full border bg-white transition-[color,box-shadow] after:absolute after:-inset-2 hover:ring-2 focus-visible:ring-3 focus-visible:outline-hidden data-active:ring-4 data-active:border-primary block shrink-0 select-none disabled:pointer-events-none disabled:opacity-50",
					thumbClass
				)}
			/>
		{/each}
	{/snippet}
</SliderPrimitive.Root>
