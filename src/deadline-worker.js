// Arm a single absolute deadline. The panel's repaint interval may be throttled.
let timer;
self.onmessage = ({ data: deadline }) => {
  clearTimeout(timer);
  if (deadline == null) return;
  function wait() {
    const remaining = deadline - Date.now();
    if (remaining > 0) timer = setTimeout(wait, Math.min(remaining, 0x7fffffff));
    else self.postMessage(deadline);
  }
  wait();
};
