<script lang="ts" module>
export type ButtonVariant =
	| "primary"
	| "secondary"
	| "ghost"
	| "accent"
	| "danger"
	| "success"
	| "warning";
export type ButtonSize = "sm" | "md" | "lg";
</script>

<script lang="ts">
import type { HTMLButtonAttributes } from "svelte/elements";
import { tooltip as attachTooltip } from "../tooltip.js";

interface Props extends Omit<HTMLButtonAttributes, "class" | "style"> {
	variant?: ButtonVariant;
	size?: ButtonSize;
	/** Square, sized by its height, for a button whose only child is an icon.
	 *  It still needs an aria-label: the icon gives it no accessible name. */
	icon?: boolean;
	/** The visual tooltip from `$lib/tooltip`, under the trigger after its delay. */
	tooltip?: string;
}

let {
	variant = "secondary",
	size = "md",
	icon = false,
	tooltip,
	type = "button",
	children,
	...rest
}: Props = $props();

const BASE =
	"inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded cursor-pointer " +
	"disabled:pointer-events-none disabled:opacity-50 " +
	"focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent " +
	"aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-on-accent";

const VARIANTS: Record<ButtonVariant, string> = {
	primary:
		"border border-accent bg-accent font-medium text-on-accent hover:bg-accent-strong",
	secondary: "border border-border bg-transparent text-text hover:bg-hover",
	ghost: "bg-transparent text-text-muted hover:bg-hover hover:text-text",
	accent: "border border-accent-border bg-accent-bg text-accent",
	danger: "border border-danger-border bg-danger-bg text-danger",
	success: "border border-success-border bg-success-bg text-success",
	warning: "border border-warning-border bg-warning-bg text-warning",
};

const SIZES: Record<ButtonSize, string> = {
	sm: "h-control-sm gap-1 px-2 text-small",
	md: "h-control gap-1 px-3 text-callout",
	lg: "h-control-lg gap-2 px-4 text-body",
};

const ICON_SIZES: Record<ButtonSize, string> = {
	sm: "size-control-sm",
	md: "size-control",
	lg: "size-control-lg",
};

function optionalTooltip(node: HTMLElement, text: string | undefined) {
	if (text === undefined) return;
	return attachTooltip(node, text);
}
</script>

<button
	{type}
	class="{BASE} {VARIANTS[variant]} {icon ? ICON_SIZES[size] : SIZES[size]}"
	use:optionalTooltip={tooltip}
	{...rest}
>
	{@render children?.()}
</button>
