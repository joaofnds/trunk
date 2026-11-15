(async ({summary, oid, files}) => {
  const probe = window.interactionProbe;
  const beforeCalls = probe.calls.length;
  const beforeFrames = probe.frames.length;
  const row = [...document.querySelectorAll('[data-testid=commit-row]')].find(x => x.textContent.includes(summary));
  if (!row) throw new Error('target row missing');
  const start = performance.now();
  row.click();
  const delivered = performance.now();
  await window.__trunkDrive.until(`document.querySelector('[data-testid="commit-row"][aria-selected="true"]')?.textContent.includes(${JSON.stringify(summary)})`);
  const feedback = performance.now();
  await window.__trunkDrive.until(`(() => {
    const d = document.querySelector('[data-testid="commit-detail"]');
    if (d?.querySelector('[title="Copy SHA"]')?.textContent.trim() !== ${JSON.stringify(oid.slice(0, 7))}) return false;
    if (d.querySelector('.summary')?.textContent.trim() !== ${JSON.stringify(summary)}) return false;
    if (!d.textContent.includes(${JSON.stringify(files + ' file' + (files === 1 ? '' : 's') + ' changed')})) return false;
    for (let node = d; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || node.inert || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    const rows = [...d.querySelectorAll('[data-testid="staging-file"]')];
    if (rows.length !== ${files}) return false;
    if (!rows.every((row, index) => row.textContent.includes('file-' + String(index).padStart(4, '0') + '.ts'))) return false;
    return rows[0].getBoundingClientRect().height > 0;
  })()`);
  const usable = performance.now();
  await new Promise(resolve => {
    const check = () => probe.calls.slice(beforeCalls).filter(c => ["invoke:commit_stat", "invoke:list_commit_files", "invoke:get_commit_detail"].includes(c.name)).length === 3 ? resolve() : requestAnimationFrame(check);
    check();
  });
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  const selectionReadsComplete = performance.now();
  return {target: oid, start, delivered, feedback, usable, selectionReadsComplete,
    backgroundSettled: null, presentedFeedback: null,
    calls: probe.calls.slice(beforeCalls), frames: probe.frames.slice(beforeFrames),
    detail: document.querySelector('[data-testid=commit-detail]')?.textContent};
})
