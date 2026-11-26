import Guacamole from '../node_modules/guacamole-common-js/dist/esm/guacamole-common.js';
import { clipboardWays } from './shared.mjs';

// Control characters other than tab and newlines. Removing them stops pasted text from carrying
// escape sequences, e.g. one that ends a terminal's bracketed paste early and runs a command.
export const clean = (text) => text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

// Shares text between the system clipboard and one remote desktop.
// Remote -> local: when the remote side copies text while its pane is the one you are using.
// Local -> remote: whenever `target` (the pane) gains focus, which also happens
// when you come back to the window from another app.
// mode: the connection's clipboard setting (clipboardWays in shared.mjs says what each word allows).
// guacd is what enforces it (remoteSettings in guacd.js); here it only keeps the page from offering what guacd drops.
export function shareClipboard(client, target, bp, mode) {
  const { toRemote, fromRemote } = clipboardWays(mode);
  let last = null; // last text seen on either side, so it is never echoed back
  let received = 0; // bumped on every remote copy, so a slow push can tell it is out of date
  let connected = false;

  client.onclipboard = (stream, mimetype) => {
    if (!fromRemote) return stream.sendAck('Clipboard sharing is off', 0x0100);
    // shortcut: text only; images and files are refused, add them if needed.
    if (!mimetype.startsWith('text/')) return stream.sendAck('Unsupported clipboard type', 0x0100);
    const reader = new Guacamole.StringReader(stream);
    let text = '';
    reader.ontext = (t) => (text += t);
    reader.onend = () => {
      // Only the pane you are working in may change your clipboard; empty means nothing was copied.
      if (!text || document.activeElement !== target || !document.hasFocus()) return;
      received++;
      last = clean(text);
      bp.clipboardWrite(last);
    };
  };

  const push = async () => {
    if (!connected || !toRemote) return;
    const before = received;
    const text = await bp.clipboardRead();
    if (!text || text === last || received !== before) return;
    last = text;
    const writer = new Guacamole.StringWriter(client.createClipboardStream('text/plain'));
    writer.sendText(text);
    writer.sendEnd();
  };
  target.addEventListener('focus', push);

  return { onConnected: () => { connected = true; push(); } };
}
