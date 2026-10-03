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
/** Only an icon button takes `xs`: a text button there puts a caption line box
 *  in a 16px frame, where no split centers it. */
type IconButtonSize = ButtonSize | "xs";
</script>

<script lang="ts">
import type { HTMLButtonAttributes } from "svelte/elements";
import { tooltip as attachTooltip } from "../tooltip.js";

type Sizing =
	| { icon?: false; size?: ButtonSize }
	| {
			/** Square, sized by its height, for a button whose only child is an icon.
			 *  It still needs an aria-label: the icon gives it no accessible name. */
			icon: true;
			size?: IconButtonSize;
	  };

type Props = Omit<HTMLButtonAttributes, "class" | "style"> &
	Sizing & {
		variant?: ButtonVariant;
		/** Inside a ButtonGroup, which draws the one frame around all of its
		 *  buttons and sets their height; the button keeps only its end corners. */
		joined?: boolean;
		/** The visual tooltip from `$lib/tooltip`, under the trigger after its delay. */
		tooltip?: string;
	};

let {
	variant = "secondary",
	size = "md",
	icon = false,
	joined = false,
	tooltip,
	type = "button",
	children,
	...rest
}: Props = $props();

const BASE =
	"relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap cursor-pointer " +
	"transition-colors motion-reduce:transition-none " +
	"disabled:pointer-events-none disabled:opacity-50 " +
	"focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent " +
	"aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-on-accent " +
	"aria-pressed:hover:border-accent-strong aria-pressed:hover:bg-accent-strong";

const FRAMES = {
	standalone: "rounded border",
	joined: "rounded-none first:rounded-l last:rounded-r",
};

const VARIANTS: Record<ButtonVariant, string> = {
	primary:
		"border-accent bg-accent font-medium text-on-accent hover:bg-accent-strong",
	secondary: "border-border bg-transparent text-text hover:bg-hover",
	ghost:
		"border-transparent bg-transparent text-text-muted hover:bg-hover hover:text-text",
	accent: "border-accent-border bg-accent-bg text-accent",
	danger: "border-danger-border bg-danger-bg text-danger",
	success: "border-success-border bg-success-bg text-success",
	warning: "border-warning-border bg-warning-bg text-warning",
};

const HEIGHTS: Record<IconButtonSize, string> = {
	xs: "h-control-xs",
	sm: "h-control-sm",
	md: "h-control",
	lg: "h-control-lg",
};

const SIZES: Record<ButtonSize, string> = {
	sm: "gap-1 px-2 text-small",
	md: "gap-1 px-3 text-callout",
	lg: "gap-2 px-4 text-body",
};

const ICON_WIDTHS: Record<IconButtonSize, string> = {
	xs: "w-control-xs",
	sm: "w-control-sm",
	md: "w-control",
	lg: "w-control-lg",
};

function optionalTooltip(node: HTMLElement, text: string | undefined) {
	if (text === undefined) return;
	return attachTooltip(node, text);
}
</script>

<button
	{type}
	class={[
		BASE,
		joined ? FRAMES.joined : FRAMES.standalone,
		VARIANTS[variant],
		joined ? null : HEIGHTS[size],
		// Sizing keeps xs off a text button; the destructured props lose that link.
		icon ? ICON_WIDTHS[size] : SIZES[size as ButtonSize],
	]}
	use:optionalTooltip={tooltip}
	{...rest}
>
	{@render children?.()}
</button>
