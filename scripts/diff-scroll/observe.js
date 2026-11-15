(async () => {
	window.diffScrollStop?.();
	document.querySelector("#diff-scroll-marker")?.remove();
	const viewport = document.querySelector(".exact-virtual-viewport");
	if (
		!viewport ||
		document.querySelectorAll(".exact-virtual-viewport").length !== 1
	)
		throw Error("expected one diff viewport");

	if (
		window.diffScrollStart < 0 ||
		window.diffScrollStart > viewport.scrollHeight - viewport.clientHeight
	)
		throw Error("initial scroll position is outside the fixture");

	viewport.scrollTop = window.diffScrollStart;
	viewport.dispatchEvent(new Event("scroll"));
	await new Promise(requestAnimationFrame);
	await new Promise(requestAnimationFrame);
	if (viewport.scrollHeight <= viewport.clientHeight)
		throw Error("fixture does not overflow");

	if (!viewport.querySelector(".diff-line-add"))
		throw Error("fixture has no added rows");

	const marker = document.createElement("div");
	marker.id = "diff-scroll-marker";
	Object.assign(marker.style, {
		position: "fixed",
		left: "8px",
		top: "220px",
		width: "128px",
		height: "8px",
		zIndex: "999999",
		display: "flex",
	});
	for (let bit = 0; bit < 16; bit++) {
		const cell = document.createElement("span");
		Object.assign(cell.style, { width: "8px", height: "8px" });
		marker.append(cell);
	}
	document.body.append(marker);
	window.diffScrollSamples = [];
	window.diffScrollSampling = true;
	window.diffScrollWheel = [];
	const onWheel = (event) =>
		window.diffScrollWheel.push({
			x: event.clientX,
			y: event.clientY,
			dy: event.deltaY,
		});
	viewport.addEventListener("wheel", onWheel, { passive: true });
	let frame;
	window.diffScrollStop = () => {
		window.diffScrollSampling = false;
		cancelAnimationFrame(frame);
		viewport.removeEventListener("wheel", onWheel);
	};
	const sample = (time) => {
		const box = viewport.getBoundingClientRect();
		const children = viewport.querySelector(".exact-virtual-rows").children;
		let low = 0;
		let high = children.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if (children[middle].getBoundingClientRect().bottom <= box.top)
				low = middle + 1;
			else high = middle;
		}
		const rows = [];
		for (let index = low; index < children.length; index++) {
			const row = children[index].getBoundingClientRect();
			if (row.top >= box.bottom) break;
			rows.push(row);
		}
		const intervals = rows
			.map((row) => [
				Math.max(box.top, row.top),
				Math.min(box.bottom, row.bottom),
			])
			.filter(([top, bottom]) => bottom > top)
			.sort((a, b) => a[0] - b[0]);
		let covered = 0;
		let end = box.top;
		for (const [top, bottom] of intervals) {
			covered += Math.max(0, bottom - Math.max(top, end));
			end = Math.max(end, bottom);
		}
		const seq = window.diffScrollSamples.length + 1;
		for (let bit = 0; bit < 16; bit++)
			marker.children[bit].style.backgroundColor =
				seq & (1 << bit) ? "white" : "black";
		window.diffScrollSamples.push({
			seq,
			t: time,
			scrollTop: viewport.scrollTop,
			max: viewport.scrollHeight - viewport.clientHeight,
			viewportTop: box.top,
			viewportBottom: box.bottom,
			coverage: covered / box.height,
			rowCount: children.length,
			rows: rows.map((row) => [row.top, row.bottom]),
		});
		if (window.diffScrollSampling && seq < 1200)
			frame = requestAnimationFrame(sample);
	};
	await new Promise((time) =>
		requestAnimationFrame((timestamp) => {
			sample(timestamp);
			time();
		}),
	);
	return viewport.getBoundingClientRect().toJSON();
})();
