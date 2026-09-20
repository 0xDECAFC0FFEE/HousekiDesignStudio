<script>
	import { cn } from "$lib/utils.js";
	let {
		ref = $bindable(null),
		inset,
		children,
		class: className,
		...restProps
	} = $props();
</script>

<div
	bind:this={ref}
	data-slot="menubar-label"
	data-inset={inset}
	class={cn("px-1.5 py-1 text-sm font-medium data-inset:pl-7", className)}
	{...restProps}
>
	{@render children?.()}
</div>