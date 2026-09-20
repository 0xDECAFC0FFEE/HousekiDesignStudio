<script>
	import { cn } from "$lib/utils.js";
	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	} = $props();
</script>

<span
	bind:this={ref}
	data-slot="menubar-shortcut"
	class={cn("text-muted-foreground group-focus/menubar-item:text-accent-foreground text-xs tracking-widest ml-auto", className)}
	{...restProps}
>
	{@render children?.()}
</span>