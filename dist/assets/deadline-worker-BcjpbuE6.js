(function(){"use strict";let e;self.onmessage=({data:t})=>{if(clearTimeout(e),t==null)return;function f(){const s=t-Date.now();s>0?e=setTimeout(f,Math.min(s,2147483647)):self.postMessage(t)}f()}})();
