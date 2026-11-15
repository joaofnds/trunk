(() => {
  if (!Array.isArray(window.interactionSamples)) throw new Error("instrumented drive build required");
  const frames = [];
  let last = performance.now();
  const frame = t => { frames.push(t - last); last = t; requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  window.interactionProbe = {calls: window.interactionSamples, frames};
  return {instrumented: true};
})()
