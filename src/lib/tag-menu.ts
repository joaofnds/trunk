/** What a tag's context menu entry does to the tag. */
export type TagAction =
	| { kind: "push"; remote: string }
	| { kind: "delete" }
	| { kind: "delete_remote"; remote: string };

export interface TagMenuEntry {
	text: string;
	action: TagAction;
	enabled: boolean;
}

/**
 * A tag's context menu, as groups a separator divides: a push to each remote,
 * then the deletes. A local delete alone comes back with the next fetch from a
 * remote that still has the tag, so each remote gets a delete of its own.
 * While a remote operation runs, the entries that talk to a remote are off.
 */
export function tagMenuEntriesOf(
	tag: string,
	remotes: readonly string[],
	remoteBusy: boolean,
): TagMenuEntry[][] {
	const onRemote = (text: string, action: TagAction): TagMenuEntry => ({
		text,
		action,
		enabled: !remoteBusy,
	});
	const local: TagMenuEntry = {
		text: remotes.length > 0 ? `Delete ${tag} locally` : `Delete ${tag}`,
		action: { kind: "delete" },
		enabled: true,
	};
	const deletes = [
		local,
		...remotes.map((remote) =>
			onRemote(`Delete ${tag} from ${remote}`, {
				kind: "delete_remote",
				remote,
			}),
		),
	];
	if (remotes.length === 0) return [deletes];

	const pushes = remotes.map((remote) =>
		onRemote(`Push ${tag} to ${remote}`, { kind: "push", remote }),
	);
	return [pushes, deletes];
}

/** Opens `groups` as a native context menu, calling `pick` with the chosen action. */
export async function popupTagMenu(
	groups: TagMenuEntry[][],
	pick: (action: TagAction) => void,
): Promise<void> {
	const { Menu, MenuItem, PredefinedMenuItem } = await import(
		"@tauri-apps/api/menu"
	);
	const items = await Promise.all(
		groups.flatMap((group, index) => [
			...(index > 0 ? [PredefinedMenuItem.new({ item: "Separator" })] : []),
			...group.map((entry) =>
				MenuItem.new({
					text: entry.text,
					enabled: entry.enabled,
					action: () => pick(entry.action),
				}),
			),
		]),
	);
	await (await Menu.new({ items })).popup();
}
