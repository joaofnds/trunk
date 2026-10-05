<script lang="ts" module>
export type HitAreaCursor = "pointer" | "context-menu";
export type HitAreaShape = "pill" | "row";
export type HitAreaRole = "menuitem";
</script>

<script lang="ts">
import type { HTMLButtonAttributes } from "svelte/elements";

interface Props
	extends Omit<HTMLButtonAttributes, "class" | "style" | "tabindex" | "role"> {
	"aria-label": string;
	/** Leave unset for a button. `menuitem` is one action in a menu. */
	role?: HitAreaRole;
	/** The cursor over it. Leave unset to keep the one of whatever is around it. */
	cursor?: HitAreaCursor;
	/** The corners of what it covers, which the pointer follows: `pill` is fully
	 *  rounded and `row` takes the small radius. Leave unset for a square box. */
	shape?: HitAreaShape;
}

let { type = "button", cursor, shape, children, ...rest }: Props = $props();

const BASE = "flex items-center size-full text-start pointer-events-auto";

const CURSORS: Record<HitAreaCursor, string> = {
	pointer: "cursor-pointer",
	"context-menu": "cursor-context-menu",
};

const SHAPES: Record<HitAreaShape, string> = {
	pill: "rounded-full",
	row: "rounded",
};
</script>

<!--
	The pointer's target over something drawn elsewhere, such as a shape in an
	svg: it fills the box it is placed in and paints nothing. It stays out of the
	Tab order, so what it does must be reachable another way.
-->
<button
	{type}
	tabindex={-1}
	class={[BASE, cursor && CURSORS[cursor], shape && SHAPES[shape]]}
	{...rest}
>
	{@render children?.()}
</button>
