// Fine-grained reactive props for svelte's `mount` in tests. testing-library's
// rerender replaces its whole $state.raw props object, re-running every effect
// on every call — it cannot prove WHICH props an effect depends on. Mutating a
// property here invalidates only that property's subscribers.
export function reactiveProps<T extends object>(initial: T): T {
	const props = $state(initial);
	return props;
}
