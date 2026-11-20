/**
 * The lines of a `ps -A -o pid=,ppid=,etime=,time=,command=` table for the
 * processes that descend from `root`, children before grandchildren. A host
 * that has not answered is often waiting on a process it started, such as
 * git, and its stack sample shows only that it waits, not on what.
 */
export function descendantsOf(table: string, root: number): string[] {
	const rows = table.split("\n").flatMap((line) => {
		const [pid, ppid] = line.trim().split(/\s+/, 2).map(Number);
		return Number.isInteger(pid) && Number.isInteger(ppid)
			? [{ pid, ppid, line: line.trim() }]
			: [];
	});

	const found: string[] = [];
	let parents = new Set([root]);
	while (parents.size > 0) {
		const children = rows.filter((row) => parents.has(row.ppid));
		found.push(...children.map((row) => row.line));
		parents = new Set(children.map((row) => row.pid));
	}
	return found;
}
