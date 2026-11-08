// Keeps screen recording checking for changes while the editor tab is in the background.
onmessage = e => { setInterval(() => postMessage(0), e.data); };
