// Stands between the page and guacd on the websocket bridge (guacamole-lite, started in guacd.js).
// Loading this file puts the filter in place.
const ClientConnection = require('guacamole-lite/lib/ClientConnection');
const Parser = require('guacamole-lite/lib/vendor/GuacamoleParser');

// What the page sends is read one instruction at a time and written out again for guacd, without the
// two that ask for files. guacd shows a shared folder as a "filesystem object": `get` asks it for a
// folder's listing or a file, `put` hands it a file. Nothing else uses those two (the screen, keys,
// mouse and clipboard have instructions of their own), and guacd answers a listing even with file
// transfer off, so they stop here. guacd is sent what was understood here, never the page's own text:
// an instruction cut across two messages, or one hidden inside another's value, is read here the way
// guacd would read it.
const FILE_REQUESTS = new Set(['get', 'put']);
const MAX_WAITING = 1 << 20; // characters of an instruction not yet complete; guacd's own limit is far lower
function fromPage(send) {
  const parser = new Parser();
  let waiting = 0;
  parser.oninstruction = (opcode, args) => {
    waiting = 0;
    if (!FILE_REQUESTS.has(opcode)) send(Parser.toInstruction([opcode, ...args]));
  };
  return (message) => {
    const text = String(message); // a Buffer from the websocket
    if (text.includes('\0')) throw new Error('The page sent a NUL character'); // guacd's names end at one: "get\0" would be `get` to guacd and something else here
    waiting += text.length;
    parser.receive(text); // throws on what is not an instruction
    // shortcut: an instruction that ends in this message resets the count, so what follows it in the same message is not counted (one message is 100 MB at most, the websocket's limit); count inside the parser if that ever matters
    if (waiting > MAX_WAITING) throw new Error('The page sent an instruction that does not end');
  };
}
// guacamole-lite passes each websocket message to guacd as it came, and has no hook to change that, so
// its method is replaced. That reaches inside the library: package.json names its exact version, and a
// version without the method stops the app here rather than run sessions with nothing in between.
const passOn = ClientConnection.prototype.sendMessageToGuacd;
if (typeof passOn !== 'function') throw new Error('guacamole-lite changed: the page filter cannot be installed');
ClientConnection.prototype.sendMessageToGuacd = function (message) {
  this.fromPage ||= fromPage((instruction) => passOn.call(this, instruction));
  try { this.fromPage(message); } catch (e) { this.close(e); }
};

module.exports = { fromPage }; // for guacd.test.js
