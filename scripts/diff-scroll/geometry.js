(async () => {
	const drive = window.__trunkDrive;
	const lines = 1500;
	const result = {
		verdict: "running",
		samples: [],
		interactions: {},
		limitations: [
			"DOM rectangles and hit-testing do not establish painted pixels or frame cadence.",
			"The added-file fixture has one hunk; [ exercises its boundary, not a previous-hunk jump.",
			"Pointer events are dispatched to hit-tested gutters, not delivered by the operating system.",
		],
	};
	let stage = "fixture";
	const check = (condition, message) => {
		if (!condition) throw Error(message);
	};
	const near = (actual, expected, label) =>
		check(
			Math.abs(actual - expected) <= 1,
			`${label}: expected ${expected}, observed ${actual}`,
		);
	const frame = () => new Promise(requestAnimationFrame);
	const mounted = async () => {
		await frame();
		await frame();
	};
	const button = (title) => document.querySelector(`button[title="${title}"]`);
	const viewport = () => {
		const matches = document.querySelectorAll(".exact-virtual-viewport");
		check(
			matches.length === 1,
			`expected one diff viewport, observed ${matches.length}`,
		);
		return matches[0];
	};
	const indexOf = (row) =>
		Number(row.dataset.lineIndex ?? row.dataset.flatIndex);
	const rowAt = (index) =>
		viewport().querySelector(
			`.diff-line-add[data-line-index="${index}"],.diff-line-add[data-flat-index="${index}"]`,
		);
	const fixtureText = (index) => {
		const id = String(index).padStart(6, "0");
		return `export const row${id} = "native diff scrolling fixture ${id}";`;
	};
	async function scroll(top) {
		const view = viewport();
		view.scrollLeft = 0;
		view.scrollTop = top === "end" ? view.scrollHeight : top;
		view.dispatchEvent(new Event("scroll"));
		await mounted();
	}
	async function mode({ content, layout, wrap }) {
		const contentSwitch = content === "hunk" ? "Show hunks" : "Show full file";
		const layoutSwitch =
			layout === "inline" ? "Inline view" : "Side-by-side view";
		if (button(contentSwitch)) await drive.click("button", contentSwitch);
		if (button(layoutSwitch)) await drive.click("button", layoutSwitch);
		const wrapButton = button("Toggle word wrap");
		check(
			wrapButton && !wrapButton.disabled,
			"word wrap control is unavailable",
		);
		if ((wrapButton.getAttribute("aria-pressed") === "true") !== wrap)
			await drive.click("button", "Toggle word wrap");

		const root =
			layout === "split"
				? ".split-view"
				: content === "hunk"
					? ".hunk-view"
					: ".full-file";
		await drive.until(
			`Boolean(document.querySelector(${JSON.stringify(`${root} .exact-virtual-rows .diff-line-add`)}))`,
		);
		await scroll(0);
		check(
			Boolean(button(content === "hunk" ? "Show full file" : "Show hunks")),
			"content mode did not change",
		);
		check(
			Boolean(
				button(layout === "inline" ? "Side-by-side view" : "Inline view"),
			),
			"layout mode did not change",
		);
		check(
			button("Toggle word wrap").getAttribute("aria-pressed") === String(wrap),
			"word wrap did not change",
		);
		const first = rowAt(0);
		check(first, "fixture row zero is not mounted");
		const code = first.querySelector(".diff-line-content");
		check(
			code.textContent.trimEnd() === fixtureText(0),
			"unexpected fixture text",
		);
		check(
			getComputedStyle(code).whiteSpace === (wrap ? "pre-wrap" : "pre"),
			"word wrap does not reach the rendered code",
		);
		const header = viewport().querySelector(".hunk-toolbar,.split-hunk-header");
		check(Boolean(header) === (content === "hunk"), "unexpected hunk header");
		const rowHeight = first.getBoundingClientRect().height;
		check(
			rowHeight > 0 && Number.isFinite(rowHeight),
			"fixture row has no measurable height",
		);
		return {
			content,
			layout,
			wrap,
			rowHeight,
			headerHeight: header?.getBoundingClientRect().height ?? 0,
		};
	}
	function hitGutter(index) {
		const row = rowAt(index);
		check(row, `expected fixture row ${index} is not mounted`);
		const grip = row.querySelector("[data-gutter-grip]");
		check(grip, `row ${index} has no selectable gutter`);
		const box = grip.getBoundingClientRect();
		const view = viewport().getBoundingClientRect();
		const x =
			(Math.max(box.left, view.left) + Math.min(box.right, view.right)) / 2;
		const y =
			(Math.max(box.top, view.top) + Math.min(box.bottom, view.bottom)) / 2;
		check(
			box.bottom > view.top && box.top < view.bottom,
			`gutter ${index} is outside the viewport`,
		);
		const hit = document.elementFromPoint(x, y);
		check(
			hit?.closest("[data-gutter-grip]") === grip,
			`hit-testing missed gutter ${index}`,
		);
		check(
			grip.getAttribute("aria-label") === `Select added line ${index + 1}`,
			`gutter ${index} has the wrong line number`,
		);
		return { hit, x, y };
	}
	async function dragGutters({ first, last, selectedAfterPress }) {
		const press = hitGutter(first);

		press.hit.dispatchEvent(
			new MouseEvent("mousedown", {
				bubbles: true,
				cancelable: true,
				button: 0,
				buttons: 1,
				clientX: press.x,
				clientY: press.y,
			}),
		);
		await drive.until(
			`Boolean(document.querySelector('.exact-virtual-rows .in-selection[data-line-index="${first}"]')) === ${selectedAfterPress}`,
		);
		const end = hitGutter(last);

		end.hit.dispatchEvent(
			new MouseEvent("mouseover", {
				bubbles: true,
				buttons: 1,
				clientX: end.x,
				clientY: end.y,
			}),
		);
		window.dispatchEvent(
			new MouseEvent("mouseup", { bubbles: true, button: 0, buttons: 0 }),
		);
	}
	function inspect(metrics, label) {
		const view = viewport();
		const box = view.getBoundingClientRect();
		const top = box.top + view.clientTop;
		const bottom = top + view.clientHeight;
		const totalHeight = metrics.headerHeight + lines * metrics.rowHeight;
		const expectedMax = Math.max(0, totalHeight - view.clientHeight);
		near(
			view.scrollHeight - view.clientHeight,
			expectedMax,
			`${label} maximum scroll`,
		);
		const rows = [...view.querySelector(".exact-virtual-rows").children];
		check(
			rows.length <= 3 * Math.ceil(view.clientHeight / metrics.rowHeight) + 6,
			`${label} mounted ${rows.length} rows`,
		);
		let edge = top;
		let gap = 0;
		for (const row of rows) {
			const rect = row.getBoundingClientRect();
			if (rect.bottom <= top || rect.top >= bottom) continue;
			gap = Math.max(gap, rect.top - edge);
			edge = Math.max(edge, Math.min(bottom, rect.bottom));
		}
		gap = Math.max(
			gap,
			Math.min(bottom, top + totalHeight - view.scrollTop) - edge,
		);
		check(gap <= 1, `${label} has a ${gap}px vertical coverage gap`);
		const visible = [
			...view.querySelectorAll(".exact-virtual-rows .diff-line-add"),
		].filter((row) => {
			const rect = row.getBoundingClientRect();
			return rect.bottom > top && rect.top < bottom;
		});
		check(visible.length > 0, `${label} has no visible fixture lines`);
		for (const row of visible) {
			const index = indexOf(row);
			const rect = row.getBoundingClientRect();
			near(
				rect.top,
				top + metrics.headerHeight + index * metrics.rowHeight - view.scrollTop,
				`${label} row ${index} top`,
			);
			near(rect.height, metrics.rowHeight, `${label} row ${index} height`);
			check(
				row.querySelector(".diff-line-content").textContent.trimEnd() ===
					fixtureText(index),
				`${label} row ${index} content`,
			);
		}
		const index = Math.floor(
			(view.scrollTop + view.clientHeight / 2 - metrics.headerHeight) /
				metrics.rowHeight,
		);
		check(
			index >= 0 && index < lines,
			`${label} center is outside the fixture`,
		);
		hitGutter(index);
		const sample = {
			label,
			...metrics,
			scrollTop: view.scrollTop,
			maximumScroll: expectedMax,
			viewportHeight: view.clientHeight,
			viewportWidth: view.clientWidth,
			mountedRows: rows.length,
			gap,
			centerIndex: index,
			firstVisibleIndex: indexOf(visible[0]),
			lastVisibleIndex: indexOf(visible.at(-1)),
		};
		result.samples.push(sample);
		return sample;
	}
	try {
		check(drive, "requires a Trunk drive build");
		for (const content of ["hunk", "full"]) {
			for (const layout of ["inline", "split"]) {
				for (const wrap of [false, true]) {
					stage = `${content}/${layout}/wrap=${wrap}`;
					const metrics = await mode({ content, layout, wrap });
					for (const position of [0, 450, 12000, "end"]) {
						stage = `${content}/${layout}/wrap=${wrap}/scroll=${position}`;
						await scroll(position);
						const sample = inspect(metrics, stage);
						near(
							sample.scrollTop,
							position === "end" ? sample.maximumScroll : position,
							`${stage} scrollTop`,
						);
					}
				}
			}
		}
		stage = "gutter selection";
		const metrics = await mode({
			content: "hunk",
			layout: "inline",
			wrap: false,
		});
		await scroll(12000);
		const before = inspect(metrics, "before selection");
		const start = before.centerIndex;
		await dragGutters({ first: start, last: start + 3, selectedAfterPress: true });
		await drive.until(
			"document.querySelectorAll('.exact-virtual-rows .in-selection').length === 4",
		);
		const selected = [...viewport().querySelectorAll(".in-selection")];
		check(
			selected.every((row, offset) => indexOf(row) === start + offset),
			"selected the wrong fixture lines",
		);
		check(
			selected[0].classList.contains("selection-first") &&
				selected.at(-1).classList.contains("selection-last"),
			"selection endpoints are missing",
		);
		result.interactions.selection = {
			first: start,
			last: start + 3,
			count: selected.length,
		};

		stage = "clear gutter selection";
		await dragGutters({
			first: start,
			last: start + 3,
			selectedAfterPress: false,
		});
		await drive.until(
			"document.querySelectorAll('.exact-virtual-viewport').length === 1 && document.querySelectorAll('.exact-virtual-rows .in-selection').length === 0",
		);
		result.interactions.selection.cleared = true;

		stage = "first hunk boundary";
		drive.key("[");
		await mounted();
		near(viewport().scrollTop, before.scrollTop, "[ at the first hunk");
		result.interactions.previousHunk = {
			verdict: "boundary-only",
			scrollTop: viewport().scrollTop,
		};

		stage = "sidebar resize";
		const slider = document.querySelector(
			'[role="slider"][aria-label="Resize sidebar"]',
		);
		if (slider && !slider.hidden) {
			const wrapped = await mode({
				content: "hunk",
				layout: "split",
				wrap: true,
			});
			await scroll(12000);
			const beforeResize = inspect(wrapped, "before sidebar resize");
			const anchor = beforeResize.firstVisibleIndex;
			const lineHeight = Number.parseFloat(
				getComputedStyle(rowAt(anchor).querySelector(".diff-line-content"))
					.lineHeight,
			);
			check(
				wrapped.rowHeight > lineHeight,
				"split fixture lines do not wrap before resize",
			);
			const original = Number(slider.getAttribute("aria-valuenow"));
			const delta =
				original + 8 <= Number(slider.getAttribute("aria-valuemax")) ? 8 : -8;

			slider.focus();
			drive.key(delta > 0 ? "ArrowRight" : "ArrowLeft");
			await drive.until(
				`document.querySelector('[role="slider"][aria-label="Resize sidebar"]').getAttribute('aria-valuenow') === '${original + delta}'`,
			);
			await mounted();

			const anchoredRow = rowAt(anchor);
			check(anchoredRow, `resize unmounted anchor row ${anchor}`);
			const sample = inspect(
				{ ...wrapped, rowHeight: anchoredRow.getBoundingClientRect().height },
				"after sidebar resize",
			);
			check(
				sample.firstVisibleIndex === anchor,
				`resize moved the first visible row from ${anchor} to ${sample.firstVisibleIndex}`,
			);
			near(
				anchoredRow.getBoundingClientRect().top,
				viewport().getBoundingClientRect().top + viewport().clientTop,
				"anchor row top after sidebar resize",
			);
			near(
				sample.viewportWidth,
				beforeResize.viewportWidth - delta,
				"diff width after sidebar key",
			);
			result.interactions.resize = {
				beforeWidth: beforeResize.viewportWidth,
				afterWidth: sample.viewportWidth,
				sidebarDelta: delta,
				anchorIndex: anchor,
				afterFirstVisibleIndex: sample.firstVisibleIndex,
				beforeScrollTop: beforeResize.scrollTop,
				afterScrollTop: sample.scrollTop,
				beforeRowHeight: beforeResize.rowHeight,
				afterRowHeight: sample.rowHeight,
			};
			slider.focus();
			drive.key(delta > 0 ? "ArrowLeft" : "ArrowRight");
			await drive.until(
				`document.querySelector('[role="slider"][aria-label="Resize sidebar"]').getAttribute('aria-valuenow') === '${original}'`,
			);
		} else {
			result.limitations.push("The sidebar resize control was unavailable.");
		}
		await mode({ content: "hunk", layout: "inline", wrap: false });
		result.verdict = "pass";
	} catch (error) {
		window.dispatchEvent(
			new MouseEvent("mouseup", { bubbles: true, buttons: 0 }),
		);
		result.verdict = "fail";
		result.failure = { stage, message: String(error) };
	}
	return result;
})();
