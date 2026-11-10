import { expect } from 'chai';
import { parseHostCapabilities, checkRequiredCommands, HOST_CAPABILITIES_PROTOCOL_VERSION, REQUIRED_BACKEND_COMMANDS, BACKEND_INCOMPATIBLE_CODE } from 'cwtools-shared';

// Handshake contract: the backend capability record is untrusted input. Every
// shape that is not a complete, protocol-matching answer must be rejected with a
// precise reason so the caller can report backend_incompatible and release the
// backend instead of driving a server whose command table it cannot trust.

describe('backend capability handshake contract', () => {
  const valid = {
    protocolVersion: HOST_CAPABILITIES_PROTOCOL_VERSION,
    serverVersion: '2.35.0',
    commands: [...REQUIRED_BACKEND_COMMANDS, 'cwtools.ai.getAllDiagnostics'],
  };

  it('accepts a complete, protocol-matching record', () => {
    const verdict = parseHostCapabilities(valid);
    expect(verdict.ok).to.equal(true);
    if (verdict.ok) {
      expect(verdict.capabilities.protocolVersion).to.equal(HOST_CAPABILITIES_PROTOCOL_VERSION);
      expect(verdict.capabilities.serverVersion).to.equal('2.35.0');
      expect(verdict.capabilities.commands).to.include('cwtools.ai.getValidationStatus');
    }
  });

  it('rejects an old backend that does not answer the command at all', () => {
    const verdict = parseHostCapabilities(undefined);
    expect(verdict.ok).to.equal(false);
    if (!verdict.ok) expect(verdict.reason).to.equal('legacy');
  });

  it('rejects a backend that answers with an unavailable error', () => {
    const verdict = parseHostCapabilities({ status: 'unavailable', error: { code: 'lsp_unavailable', message: 'unknown command' } });
    expect(verdict.ok).to.equal(false);
    if (!verdict.ok) {
      expect(verdict.reason).to.equal('legacy');
      expect(verdict.message).to.include('unknown command');
    }
  });

  it('rejects malformed payloads field by field', () => {
    const cases: Array<[string, unknown]> = [
      ['protocolVersion', { ...valid, protocolVersion: '1' }],
      ['protocolVersion', { ...valid, protocolVersion: 1.5 }],
      ['serverVersion', { ...valid, serverVersion: '' }],
      ['serverVersion', { ...valid, serverVersion: 7 }],
      ['commands', { ...valid, commands: 'a,b' }],
      ['commands', { ...valid, commands: [1, 2] }],
    ];
    for (const [field, payload] of cases) {
      const verdict = parseHostCapabilities(payload);
      expect(verdict.ok, field).to.equal(false);
      if (!verdict.ok) {
        expect(verdict.reason, field).to.equal('malformed');
        expect(verdict.message, field).to.include(field);
      }
    }
  });

  it('rejects a protocol mismatch even when the shape is valid', () => {
    const verdict = parseHostCapabilities({ ...valid, protocolVersion: HOST_CAPABILITIES_PROTOCOL_VERSION + 1 });
    expect(verdict.ok).to.equal(false);
    if (!verdict.ok) {
      expect(verdict.reason).to.equal('protocol');
      expect(verdict.message).to.include(String(HOST_CAPABILITIES_PROTOCOL_VERSION + 1));
    }
  });

  it('rejects an empty command table as incomplete', () => {
    const verdict = parseHostCapabilities({ ...valid, commands: [] });
    expect(verdict.ok).to.equal(false);
    if (!verdict.ok) expect(verdict.reason).to.equal('incomplete');
  });

  it('rejects a well-formed record that lacks a required command', () => {
    const parsed = parseHostCapabilities({ ...valid, commands: ['cwtools.ai.getValidationStatus'] });
    expect(parsed.ok).to.equal(true);
    if (parsed.ok) {
      const checked = checkRequiredCommands(parsed.capabilities);
      expect(checked.ok).to.equal(false);
      if (!checked.ok) {
        expect(checked.reason).to.equal('incomplete');
        expect(checked.message).to.include('cwtools.ai.queryTypes');
      }
    }
  });

  it('exposes a stable error code for the incompatible backend', () => {
    expect(BACKEND_INCOMPATIBLE_CODE).to.equal('backend_incompatible');
  });
});
