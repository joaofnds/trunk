/** What the harness puts on the page before any of the page's own scripts run. */
export interface PageBindings {
	__trunkInvoke(cmd: string, args: unknown): Promise<unknown>;
	__trunkHome(): Promise<string>;
	/** Commands sent to the host and not yet answered: zero is one half of "settled". */
	__trunkPending: number;
	/** Events the host emitted before a handler registered are delivered to it
	 *  on registration, so none is lost to the page's own load order. */
	__trunkOnEvent(handler: (event: string, payload: unknown) => void): void;
	__trunkDeliver(event: string, payload: unknown): void;
}

declare global {
	interface Window extends PageBindings {}
}
