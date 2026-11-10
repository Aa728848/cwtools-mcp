// Scripted CWTools backend used by the cancellation / handshake ordering tests.
// Speaks real JSON-RPC over stdio so the tests exercise the actual transport
// (including $/cancelRequest) instead of a stub.
'use strict';
const fs = require('fs');
const rpc = require('vscode-jsonrpc/node');

const mode = process.argv[2] || 'ok';
const logFile = process.argv[3];
const commandsJson = process.argv[4] || '[]';

function log(line) {
  if (logFile) fs.appendFileSync(logFile, line + '\n');
}

log('PID ' + process.pid);
process.on('exit', () => log('EXIT'));

const connection = rpc.createMessageConnection(
  new rpc.StreamMessageReader(process.stdin),
  new rpc.StreamMessageWriter(process.stdout));

connection.onNotification((method) => { log('NOTIFY ' + method); });

connection.onRequest('initialize', async () => {
  log('INITIALIZE');
  if (mode === 'hang-initialize') return new Promise(() => {});
  return { capabilities: {} };
});

connection.onRequest('workspace/executeCommand', async (params, token) => {
  const command = params && params.command;
  if (command === 'cwtools.ai.getHostCapabilities') {
    log('CAPABILITIES');
    if (mode === 'hang-capabilities') return new Promise(() => {});
    if (mode === 'legacy') {
      return { ok: false, status: 'unavailable', error: { code: 'lsp_unavailable', message: 'unknown command' } };
    }
    if (mode === 'incomplete') {
      return { protocolVersion: 1, serverVersion: '2.35.0', commands: ['cwtools.ai.getValidationStatus'] };
    }
    if (mode === 'malformed') {
      return { protocolVersion: '1', serverVersion: '2.35.0', commands: [] };
    }
    return { protocolVersion: 1, serverVersion: '2.35.0', commands: JSON.parse(commandsJson) };
  }
  if (command === 'slow.command') {
    log('REQUEST ' + command);
    // Cancellation is delivered through the request token; record it so the test
    // can prove a real $/cancelRequest arrived instead of the client giving up.
    token.onCancellationRequested(() => log('CANCELLED ' + command));
    return new Promise(() => {});
  }
  if (command === 'cwtools.ai.getValidationStatus') return { ok: true, loading: { phase: 'ready' } };
  if (command === 'cwtools.ai.getAllDiagnostics' || command === 'cwtools.ai.getDiagnosticsFresh') return null;
  return { ok: true };
});

connection.listen();
