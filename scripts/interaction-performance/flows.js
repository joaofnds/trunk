(() => {
  if (!window.interactionProbe) throw new Error("install observe.js first");

  const shown = element => element instanceof HTMLElement &&
    getComputedStyle(element).visibility !== "hidden" && element.getClientRects().length > 0;
  const all = selector => [...document.querySelectorAll(selector)].filter(shown);
  const one = selector => {
    const matches = all(selector);
    if (matches.length !== 1) throw new Error(`${selector}: expected one visible element, found ${matches.length}`);

    return matches[0];
  };
  const button = name => {
    const matches = all("button").filter(element =>
      element.getAttribute("aria-label") === name || element.textContent.trim() === name);
    if (matches.length !== 1 || matches[0].disabled) throw new Error(`enabled button unavailable: ${name} (${matches.length})`);

    return matches[0];
  };
  // Read the visible destination in either label style. Older builds
  // without data-path expose the whole path as text.
  const displayedPath = element => {
    const path = element.dataset.path;
    const leaf = element.querySelector(".leaf:not(.former) bdi");
    if (leaf?.textContent === path && !element.querySelector(".context")) return path;
    const end = path.endsWith("/") ? path.length - 1 : path.length;
    const slash = path.lastIndexOf("/", end - 1);
    if (leaf?.textContent !== path.slice(slash + 1)) return undefined;
    if (element.getAttribute("role") === "treeitem") return path;

    const directory = path.slice(0, Math.max(0, slash));
    const displayed = element.querySelector(".context .directory:last-child bdi")?.textContent ?? "";
    return displayed === directory || displayed === (directory || ".") + "/" ? path : undefined;
  };
  const filePath = element => element.dataset.path === undefined
    ? element.querySelector("span.flex-1 > span")?.textContent.trim()
    : displayedPath(element);
  const diffPath = element => element?.dataset.path === undefined
    ? element?.textContent.trim() : displayedPath(element);
  const showsFile = (row, path) => row.dataset.path === undefined
    ? [...row.querySelectorAll("span")].some(span => span.textContent.trim() === path)
    : displayedPath(row) === path;
  const file = (section, path) => {
    const matches = all(`${section} [data-testid="staging-file"]`).filter(row => showsFile(row, path));
    if (matches.length !== 1) throw new Error(`file unavailable: ${section} ${path} (${matches.length})`);

    return matches[0];
  };
  const wait = (label, predicate) => new Promise((resolve, reject) => {
    let frame;
    const observer = new MutationObserver(check);
    const timeout = setTimeout(() => finish(new Error(`timeout: ${label}`)), 15000);

    function finish(error) {
      clearTimeout(timeout);
      cancelAnimationFrame(frame);
      observer.disconnect();
      if (error) reject(error);
      else resolve(performance.now());
    }

    function check() {
      try {
        if (predicate()) finish();
      } catch (error) {
        finish(error);
      }
    }

    function tick() {
      frame = requestAnimationFrame(tick);
      check();
    }

    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    frame = requestAnimationFrame(tick);
    check();
  });
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  const options = { contextLines: 3, ignoreWhitespace: false, showFullFile: false };
  const paths = kind => all(`[data-testid="staging-${kind}-section"] [data-testid="staging-file"]`)
    .map(filePath).sort();
  const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify([...expected].sort());
  const statusReady = expected => all('[data-testid="staging-staged-section"]').length === 1 &&
    all('[data-testid="staging-unstaged-section"]').length === 1 &&
    same(paths("staged"), expected.staged) && same(paths("unstaged"), expected.unstaged);
  const detailReady = oid => all('[data-testid="commit-detail"] [title="Copy SHA"]')
    .some(element => element.textContent.trim() === oid.slice(0, 7));
  const paneState = side => {
    const control = side === "left" ? one('[data-testid="branch-sidebar"] input')
      : one('[data-testid="commit-form-subject"]');
    const pane = control.closest('main > div[style*="width"]');
    if (!pane) throw new Error(`missing ${side} pane container`);
    const bounds = pane.getBoundingClientRect();
    const controlBounds = control.getBoundingClientRect();
    const splitter = pane.parentElement.querySelector(`[aria-label="Resize ${side === "left" ? "sidebar" : "detail pane"}"]`);
    if (!(splitter instanceof HTMLElement)) throw new Error(`missing ${side} pane splitter`);
    return { bounds: bounds.toJSON(), controlBounds: controlBounds.toJSON(),
      controlEnabled: !control.disabled, controlValue: control.value,
      controlInside: Math.min(bounds.right, controlBounds.right) > Math.max(bounds.left, controlBounds.left) &&
        Math.min(bounds.bottom, controlBounds.bottom) > Math.max(bounds.top, controlBounds.top),
      splitterHidden: splitter.hidden, focusedHtml: document.activeElement?.outerHTML.slice(0, 500) };
  };
  const treeReady = expected => ["staged", "unstaged"].every(kind => {
    const rows = all(`[data-testid="staging-${kind}-section"] [role="treeitem"][aria-expanded]`);
    return rows.length === expected[kind].length && expected[kind].every(({ name, count }) =>
      rows.some(row => [...row.querySelectorAll("span")].some(span => span.textContent.trim() === name) &&
        [...row.querySelectorAll("span")].some(span => span.textContent.trim() === `(${count})`)));
  });
  const pathReady = path => all('[data-testid="diff-path"]').some(element => diffPath(element) === path);
  const contentReady = text => all(".diff-line-content").some(element => element.textContent.includes(text));
  const callsSince = index => window.interactionProbe.calls.slice(index);
  const completed = (index, command) => callsSince(index).some(call => call.name === `invoke:${command}`);
  const partialMutationReady = spec => {
    const kind = spec.op.startsWith("unstage") ? "staged" : "unstaged";
    const remaining = spec.expectedMarkers[kind];
    if (!remaining.length) return all('[data-testid="diff-path"]').length === 0;

    const markers = all(".diff-line-add .diff-line-content")
      .map(element => element.textContent.trim()).filter(text => text.includes("matrix_marker_"));
    const controls = all("button").filter(element => element.textContent.trim() === "Stage Hunk");

    return pathReady(spec.path) && same(markers, remaining) && controls.length > 0 &&
      controls.every(element => !element.disabled);
  };
  const setInput = (element, value) => {
    element.focus();
    element.value = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  };
  const markers = diffs => diffs.flatMap(diff => diff.hunks.flatMap(hunk => hunk.lines))
    .filter(line => line.origin === "Add" && line.content.includes("matrix_marker_"))
    .map(line => line.content.trim()).sort();

  async function verify(spec) {
    if (spec.op === "pane-toggle") return paneState(spec.pane);

    if (spec.op === "rapid-history") {
      const detail = await invoke("get_commit_detail", { path: spec.repo, oid: spec.oid });
      const files = await invoke("list_commit_files", { path: spec.repo, oid: spec.oid });
      if (detail.oid !== spec.oid || detail.summary !== spec.summary ||
          !same(files.map(entry => entry.path).sort(), spec.files)) {
        throw new Error(`history identity mismatch: ${JSON.stringify({ detail, files })}`);
      }

      return { detail, files };
    }

    if (spec.op === "commit-file" || spec.op === "rapid-files") {
      const diffs = await invoke("diff_commit_file", { path: spec.repo, oid: spec.oid, filePath: spec.path, options });
      const lines = diffs.flatMap(diff => diff.hunks.flatMap(hunk => hunk.lines));
      const index = Number(spec.path.match(/file-(\d+)\.ts/)[1]);
      const added = lines.find(line => line.origin === "Add");
      const deleted = lines.find(line => line.origin === "Delete");
      if (diffs.length !== 1 || diffs[0].path !== spec.path ||
          !added?.content.includes(`file ${index} revision 2 line 0`) ||
          !deleted?.content.includes(`file ${index} revision 1 line 0`)) {
        throw new Error(`commit diff content mismatch: ${spec.oid} ${spec.path}`);
      }

      return { oid: spec.oid, path: spec.path, added: added.content, deleted: deleted.content };
    }

    if (spec.expectedStatus) {
      const status = await invoke("get_status", { path: spec.repo });
      if (!same(status.staged.map(entry => entry.path).sort(), spec.expectedStatus.staged) ||
          !same(status.unstaged.map(entry => entry.path).sort(), spec.expectedStatus.unstaged) || status.conflicted.length) {
        throw new Error(`Git status mismatch: ${JSON.stringify(status)}`);
      }

      if (spec.expectedMarkers) {
        for (const kind of ["staged", "unstaged"]) {
          const diffs = await invoke(`diff_${kind}`, { path: spec.repo, filePath: spec.path, options });
          if (!same(markers(diffs), spec.expectedMarkers[kind])) {
            throw new Error(`Git ${kind} content mismatch: ${JSON.stringify(markers(diffs))}`);
          }
        }
      }

      if (spec.expectedAddedFiles) {
        for (const [path, expected] of Object.entries(spec.expectedAddedFiles)) {
          for (const kind of ["staged", "unstaged"]) {
            const diffs = await invoke(`diff_${kind}`, { path: spec.repo, filePath: path, options });
            const added = diffs.flatMap(diff => diff.hunks.flatMap(hunk => hunk.lines))
              .filter(line => line.origin === "Add").map(line => line.content).join("");
            const wanted = spec.expectedStatus[kind].includes(path) ? expected : "";
            if (added !== wanted) throw new Error(`directory ${kind} content mismatch: ${path}`);
          }
        }
      }

      if (spec.op === "commit-failure") {
        const graph = await invoke("get_commit_graph", { path: spec.repo, offset: 0 });
        const head = graph.commits.find(commit => commit.is_head);
        if (head?.oid !== spec.expectedHead) throw new Error(`rejected commit changed HEAD: ${JSON.stringify(head)}`);

        return { status, head };
      }

      return status;
    }

    if (spec.op === "commit") {
      const graph = await invoke("get_commit_graph", { path: spec.repo, offset: 0 });
      const head = graph.commits.find(commit => commit.is_head);
      if (!head || head.summary !== spec.subject || head.parent_oids[0] !== spec.parent) {
        throw new Error(`committed HEAD mismatch: ${JSON.stringify(head)}`);
      }

      const files = await invoke("list_commit_files", { path: spec.repo, oid: head.oid });
      const status = await invoke("get_status", { path: spec.repo });
      if (!same(files.map(entry => entry.path).sort(), spec.changedFiles) ||
          status.staged.length || status.unstaged.length || status.conflicted.length) {
        throw new Error(`commit did not preserve expected paths and clean status: ${JSON.stringify({ files, status })}`);
      }

      for (const path of spec.changedFiles) {
        const diff = await invoke("diff_commit_file", { path: spec.repo, oid: head.oid, filePath: path, options });
        if (!same(markers(diff), spec.committedMarkers[path])) throw new Error(`committed content mismatch: ${path}`);
      }

      return { head, status, changedFiles: files.map(entry => entry.path) };
    }

    return { kind: "DOM identity and content", oid: spec.oid ?? null, path: spec.path ?? null };
  }

  async function run(spec) {
    const probe = window.interactionProbe;
    const beforeCalls = probe.calls.length;
    const beforeFrames = probe.frames.length;
    const deliveries = [];
    const transitions = [];
    window.interactionFlowLast = { spec, deliveries, transitions };
    let action;
    let feedback;
    let ready;

    switch (spec.op) {
      case "select-commit":
        action = () => {
          const row = all('[data-testid="commit-row"]').find(element => element.textContent.includes(spec.summary));
          if (!row) throw new Error(`missing commit row: ${spec.summary}`);
          row.click();
        };
        feedback = () => all('[data-testid="commit-row"][aria-selected="true"]')
          .some(element => element.textContent.includes(spec.summary));
        ready = () => detailReady(spec.oid) && all('[data-testid="commit-detail"]')
          .some(element => element.textContent.includes(`${spec.fileCount} files changed`));
        break;
      case "ref-navigate":
        action = () => {
          const matches = all('[data-testid="branch-sidebar"] button').filter(element =>
            [...element.querySelectorAll("span")].some(span => span.textContent.trim() === spec.ref));
          if (matches.length !== 1) throw new Error(`ref button unavailable: ${spec.ref}`);

          matches[0].addEventListener("click", event => deliveries.push({ at: performance.now(), ref: spec.ref,
            oid: spec.oid, type: event.type, isTrusted: event.isTrusted }), { capture: true, once: true });
          matches[0].click();
        };
        feedback = () => detailReady(spec.oid);
        ready = () => completed(beforeCalls, "resolve_ref") && feedback() &&
          all('[data-testid="commit-detail"] .summary').some(element => element.textContent.trim() === spec.summary) &&
          all('[data-testid="commit-row"][aria-selected="true"]').some(element => element.textContent.includes(spec.summary)) &&
          same(all('[data-testid="commit-detail"] [data-testid="staging-file"]')
            .map(filePath).sort(), spec.files);
        break;
      case "commit-file":
        action = () => file('[data-testid="commit-detail"]', spec.path).click();
        feedback = () => pathReady(spec.path);
        ready = () => detailReady(spec.oid) && pathReady(spec.path) && contentReady(spec.content);
        break;
      case "rapid-files":
        action = async () => {
          for (const path of spec.sequence) {
            const scheduledAfterPreviousMs = spec.spacingMs;
            if (deliveries.length) await new Promise(resolve => setTimeout(resolve, spec.spacingMs));
            const at = performance.now();
            file('[data-testid="commit-detail"]', path).click();
            deliveries.push({ path, at, scheduledAfterPreviousMs, returned: performance.now() });
          }
        };
        feedback = () => pathReady(spec.path);
        ready = () => detailReady(spec.oid) && pathReady(spec.path) && contentReady(spec.content);
        break;
      case "history-key":
        action = () => {
          document.activeElement?.blur();
          const observeKey = event => deliveries.push({ key: event.key, at: performance.now(),
            target: event.target instanceof Element ? event.target.outerHTML.slice(0, 500) : String(event.target),
            active: document.activeElement?.outerHTML.slice(0, 500) });
          window.addEventListener("keydown", observeKey, { capture: true, once: true });
          window.__trunkDrive.key(spec.key);
        };
        feedback = () => detailReady(spec.oid);
        ready = feedback;
        break;
      case "rapid-history":
        action = () => {
          document.activeElement?.blur();
          for (const key of spec.sequence) {
            const receipt = { key, before: performance.now() };
            const observeKey = event => Object.assign(receipt, {
              at: performance.now(), eventTimestamp: event.timeStamp, isTrusted: event.isTrusted,
              target: event.target instanceof Element ? event.target.outerHTML.slice(0, 500) : String(event.target),
            });
            window.addEventListener("keydown", observeKey, { capture: true, once: true });
            window.__trunkDrive.key(key);
            receipt.returned = performance.now();
            window.removeEventListener("keydown", observeKey, { capture: true });
            deliveries.push(receipt);
            if (receipt.at === undefined) throw new Error(`history key was not delivered: ${key}`);
          }
        };
        feedback = () => detailReady(spec.oid);
        ready = () => feedback() && all('[data-testid="commit-row"][aria-selected="true"]')
          .some(element => element.textContent.includes(spec.summary)) &&
          all('[data-testid="commit-detail"] .summary').some(element => element.textContent.trim() === spec.summary) &&
          same(all('[data-testid="commit-detail"] [data-testid="staging-file"]')
            .map(filePath).sort(), spec.files);
        break;
      case "pane-toggle": {
        const focus = button("Review");
        focus.focus();
        if (document.activeElement !== focus) throw new Error("pane command focus was not established");
        const before = paneState(spec.pane);
        window.interactionPaneWidths ??= {};
        if (!spec.open) {
          if (before.bounds.width <= 0) throw new Error(`${spec.pane} pane already collapsed`);
          window.interactionPaneWidths[spec.pane] = before.bounds.width;
        } else if (before.bounds.width !== 0 || !window.interactionPaneWidths[spec.pane]) {
          throw new Error(`${spec.pane} pane was not collapsed by this matrix`);
        }
        action = () => {
          const receipt = { key: spec.key, before: performance.now(), paneBefore: before };
          const observeKey = event => Object.assign(receipt, { at: performance.now(),
            keyReceived: event.key, metaKey: event.metaKey, isTrusted: event.isTrusted,
            target: event.target instanceof Element ? event.target.outerHTML.slice(0, 500) : String(event.target) });
          window.addEventListener("keydown", observeKey, { capture: true, once: true });
          window.__trunkDrive.key(spec.key);
          receipt.returned = performance.now();
          window.removeEventListener("keydown", observeKey, { capture: true });
          deliveries.push(receipt);
          if (receipt.at === undefined || !receipt.metaKey) throw new Error(`pane command was not delivered: ${spec.key}`);
        };
        feedback = () => paneState(spec.pane).bounds.width === (spec.open ? window.interactionPaneWidths[spec.pane] : 0);
        ready = () => {
          const state = paneState(spec.pane);
          return feedback() && document.activeElement === focus && state.splitterHidden === !spec.open &&
            state.controlInside === spec.open && state.controlEnabled &&
            (spec.pane !== "right" || state.controlValue === spec.draft);
        };
        break;
      }
      case "close-diff":
        action = () => button("Close diff").click();
        feedback = () => all('[data-testid="diff-path"]').length === 0;
        ready = () => feedback() && (spec.returnTo === "review"
          ? all('[aria-label="Review threads"]').length === 1
          : all('[data-testid="commit-row-summary"]').length > 0) &&
          (!spec.requirePager || all('[aria-label="Go to older commit"]').some(element => !element.disabled));
        break;
      case "close-detail":
        action = () => button("Close commit detail").click();
        feedback = () => all('[data-testid="commit-detail"]').length === 0;
        ready = () => feedback() && statusReady(spec.expectedStatus);
        break;
      case "search":
        action = () => setInput(one('input[placeholder="Search commits…"]'), spec.query);
        feedback = () => one('input[placeholder="Search commits…"]').value === spec.query;
        ready = () => detailReady(spec.oid) && all(".search-bar").some(element => element.textContent.includes("1 of 1"));
        break;
      case "rapid-search":
        action = async () => {
          for (const query of spec.sequence) {
            if (deliveries.length) await new Promise(resolve => setTimeout(resolve, spec.spacingMs));
            const at = performance.now();
            setInput(one('input[placeholder="Search commits…"]'), query);
            deliveries.push({ query, at, scheduledAfterPreviousMs: spec.spacingMs, returned: performance.now() });
          }
        };
        feedback = () => one('input[placeholder="Search commits…"]').value === spec.query;
        ready = () => detailReady(spec.oid) && all(".search-bar").some(element => element.textContent.includes("1 of 1"));
        break;
      case "close-search":
        action = () => button("Close search").click();
        feedback = () => all('input[placeholder="Search commits…"]').length === 0;
        ready = feedback;
        break;
      case "working-file":
        action = () => file(`[data-testid="staging-${spec.kind}-section"]`, spec.path).click();
        feedback = () => pathReady(spec.path);
        ready = () => pathReady(spec.path) && contentReady(spec.content) &&
          completed(beforeCalls, `diff_${spec.kind}`);
        break;
      case "stage-line":
      case "unstage-line":
        action = async () => {
          const line = all(".diff-line-add").find(element => element.textContent.includes(spec.marker));
          const grip = line?.querySelector("[data-gutter-grip]");
          if (!(grip instanceof HTMLElement)) throw new Error(`selectable line unavailable: ${spec.marker}`);
          grip.focus();
          window.__trunkDrive.key("Enter");
          await wait("one line selected", () => all("button").some(element => element.textContent.trim() === spec.button));
          button(spec.button).click();
        };
        feedback = () => completed(beforeCalls, spec.command);
        ready = () => feedback() && statusReady(spec.expectedStatus) && partialMutationReady(spec);
        break;
      case "stage-hunk":
      case "unstage-hunk":
        action = () => {
          const buttons = all("button").filter(element => element.textContent.trim() === spec.button && !element.disabled);
          if (!buttons.length) throw new Error(`hunk action unavailable: ${spec.button}`);
          buttons[0].click();
        };
        feedback = () => completed(beforeCalls, spec.command);
        ready = () => feedback() && statusReady(spec.expectedStatus) && partialMutationReady(spec);
        break;
      case "stage-file":
      case "unstage-file":
        action = () => {
          const row = file(`[data-testid="staging-${spec.kind}-section"]`, spec.path);
          row.focus();
          const target = row.closest(".row")?.querySelector(`[aria-label="${spec.button}"]`);
          if (!(target instanceof HTMLButtonElement) || target.disabled) throw new Error(`file action unavailable: ${spec.button}`);
          target.click();
        };
        feedback = () => statusReady(spec.expectedStatus);
        ready = () => feedback() && completed(beforeCalls, spec.command);
        break;
      case "stage-all":
      case "unstage-all":
        action = () => button(spec.button).click();
        feedback = () => statusReady(spec.expectedStatus);
        ready = () => feedback() && completed(beforeCalls, spec.command);
        break;
      case "tree-view":
        action = () => button(spec.open ? "Switch to tree view" : "Switch to list view").click();
        feedback = () => all(`[aria-label="${spec.open ? "Switch to list view" : "Switch to tree view"}"]`).length === 1;
        ready = () => feedback() && (spec.open ? treeReady(spec.treeStatus) : statusReady(spec.expectedStatus));
        break;
      case "stage-directory":
      case "unstage-directory":
        action = () => {
          const rows = all(`[data-testid="staging-${spec.kind}-section"] [role="treeitem"][aria-expanded]`)
            .filter(row => [...row.querySelectorAll("span")].some(span => span.textContent.trim() === spec.directory));
          if (rows.length !== 1) throw new Error(`directory row unavailable: ${spec.directory}`);
          const target = rows[0].closest(".row")?.querySelector(`[aria-label="${spec.button}"]`);
          if (!(target instanceof HTMLButtonElement) || target.disabled) throw new Error(`directory action unavailable: ${spec.button}`);
          target.click();
        };
        feedback = () => treeReady(spec.treeStatus);
        ready = () => feedback() && completed(beforeCalls, spec.command);
        break;
      case "commit":
      case "commit-failure":
        setInput(one('[data-testid="commit-form-subject"]'), spec.subject);
        await wait("commit subject applied", () => one('[data-testid="commit-form-subject"]').value === spec.subject);
        action = () => one('[data-testid="commit-form-submit"]').click();
        feedback = () => one('[data-testid="commit-form-submit"]').disabled;
        ready = spec.op === "commit" ? () => completed(beforeCalls, "create_commit") &&
          statusReady({ staged: [], unstaged: [] }) && one('[data-testid="commit-form-subject"]').value === "" &&
          all('[data-testid="commit-row-summary"]').some(element => element.textContent.trim() === spec.subject)
          : () => completed(beforeCalls, "create_commit") && statusReady(spec.expectedStatus) &&
            !one('[data-testid="commit-form-submit"]').disabled &&
            one('[data-testid="commit-form-subject"]').value === spec.subject;
        break;
      case "repo-tab":
        action = () => {
          const tab = one(`[data-tab-id="${spec.tab}"] [role="tab"]`);
          tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
        };
        feedback = () => one(`[data-tab-id="${spec.tab}"] [role="tab"]`).getAttribute("aria-selected") === "true";
        ready = () => feedback() && statusReady(spec.expectedStatus);
        break;
      case "review-view":
        action = () => button("Review").click();
        feedback = () => button("Review").getAttribute("aria-pressed") === String(spec.open);
        ready = () => feedback() && (all('[aria-label="Review threads"]').length > 0) === spec.open;
        break;
      case "finder-open":
        action = () => button("Comment on a file…").click();
        feedback = () => all('[aria-label="Find a tracked file to comment on"]').length === 1;
        ready = () => {
          if (!feedback()) return false;

          const rows = all('#file-finder-list [role="option"]');
          const first = rows[0];
          if (!first) return false;

          const total = first.getAttribute("aria-setsize");
          if (total === null) return rows.length === spec.fileCount;

          const viewportHeight = first.closest("#file-finder-list").clientHeight;
          const rowHeight = first.getBoundingClientRect().height;
          return Number(total) === spec.fileCount && viewportHeight > 0 && rowHeight > 0 &&
            rows.length >= Math.min(spec.fileCount, Math.ceil(viewportHeight / rowHeight));
        };
        break;
      case "finder-search":
        action = () => setInput(one('[aria-label="Find a tracked file to comment on"]'), spec.path);
        feedback = () => one('[aria-label="Find a tracked file to comment on"]').value === spec.path;
        ready = () => {
          const rows = all('#file-finder-list [role="option"]');
          return rows.length === 1 && showsFile(rows[0], spec.path);
        };
        break;
      case "finder-pick":
        action = () => one('#file-finder-list [role="option"]').click();
        feedback = () => pathReady(spec.path);
        ready = () => pathReady(spec.path) && contentReady(spec.content) && completed(beforeCalls, "open_current_file");
        break;
      default:
        throw new Error(`unknown flow: ${spec.op}`);
    }

    let actionStarted = false;
    let actionReturned = false;
    const contentObserver = new MutationObserver(() => {
      const path = diffPath(all('[data-testid="diff-path"]')[0]);
      const content = all('.diff-line-content')[0]?.textContent;
      if (path && content && (transitions.at(-1)?.path !== path || transitions.at(-1)?.content !== content)) {
        transitions.push({ at: performance.now(), path, content });
      }
    });
    contentObserver.observe(document, { subtree: true, childList: true, characterData: true, attributeFilter: ["data-path"] });
    const start = performance.now();
    const wallStart = Date.now();
    Object.assign(window.interactionFlowLast, { start, wallStart, beforeCalls, beforeFrames });
    const feedbackPending = wait(`${spec.op} feedback`, () => actionStarted && feedback());
    const readyPending = wait(`${spec.op} usable result`, () => actionReturned && ready());
    const pending = Promise.all([feedbackPending, readyPending]);
    actionStarted = true;
    await action();
    actionReturned = true;
    const delivered = performance.now();
    const [feedbackAt, usable] = await pending;
    const beforeOracle = performance.now();
    const oracle = await verify(spec);
    const oracleComplete = performance.now();
    const wallComplete = Date.now();
    contentObserver.disconnect();
    for (const transition of transitions) {
      const pathIndex = transition.path.match(/^file-(\d+)\.ts$/)?.[1];
      const contentIndex = transition.content.match(/file (\d+) revision \d+ line \d+/)?.[1];
      if (pathIndex !== undefined && contentIndex !== undefined && Number(pathIndex) !== Number(contentIndex)) {
        throw new Error(`observed mismatched diff identity: ${JSON.stringify(transition)}`);
      }
    }

    return {
      spec, start, delivered, feedback: feedbackAt, usable, beforeOracle, oracleComplete, oracle,
      wallStart, wallComplete,
      firstVisibleFeedback: null, backgroundSettled: null,
      endpointLimit: "Feedback is the flow-specific DOM predicate, which for hunk and line mutations is command completion. Usable is DOM readiness, not presented pixels. No global background-settled signal is available.",
      deliveries, transitions, calls: callsSince(beforeCalls), frames: probe.frames.slice(beforeFrames),
      commandIntervals: callsSince(beforeCalls).filter(call => call.kind === "span" && call.name.startsWith("invoke:"))
        .map(call => ({ command: call.name.slice(7), startEstimateWallMs: call.at - call.ms,
          endWallMs: call.at, durationMs: call.ms, attrs: call.attrs ?? null })),
      attributionLimit: "Command spans estimate wall-clock overlap; they do not identify foreground ownership, queue wait, CPU cost, or unfinished work. Oracle commands are uninstrumented direct IPC.",
    };
  }

  window.interactionFlows = { run };
  return { installed: true };
})()
