// Compatibility surface: the Node host services moved to `cwtools-node` so a
// consumer with no MCP dependency can host CWTools in-process. These re-exports
// keep every previously published deep import working.
export * from 'cwtools-node';
export * from './config';
export * from './mcp/callHandler';
export * from './mcp/toolHandlers';
export * from './mcp/toolRegistrar';
export * from './mcp/resources';
export * from './mcp/transportHttp';
export * from './mcp/transportStdio';
export * from './server';
