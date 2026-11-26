import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as catalogEntry from '../catalog';
import * as root from '../index';

const srcRoot = path.resolve(__dirname, '..');
const packageRoot = path.resolve(srcRoot, '..');

// Runtime imports and re-exports; `import type` / `export type` are erased.
const RUNTIME_IMPORT = /(?:^|;|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const REQUIRE_CALL = /\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveSource(fromFile: string, specifier: string): string {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base + '.ts', path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot resolve ${specifier} from ${fromFile}`);
}

/** Every source file the entry loads at runtime, and every non-relative specifier it requests. */
function runtimeImportGraph(entry: string): { files: string[]; externals: string[] } {
  const files = new Set<string>();
  const externals = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of [RUNTIME_IMPORT, REQUIRE_CALL]) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1]!;
        if (specifier.startsWith('.')) pending.push(resolveSource(file, specifier));
        else externals.add(specifier);
      }
    }
  }
  return {
    files: [...files].map(file => path.relative(srcRoot, file).split(path.sep).join('/')).sort(),
    externals: [...externals].sort(),
  };
}

describe('browser-safe catalog entry contract', () => {
  it('loads only the generated catalog, its schema helpers and the name tables', () => {
    const graph = runtimeImportGraph(path.join(srcRoot, 'catalog.ts'));
    expect(graph.externals, 'cwtools-shared/catalog must not import packages or Node builtins').to.deep.equal([]);
    expect(graph.files).to.deep.equal(['catalog.ts', 'tools/catalog.ts', 'tools/mcpSchema.ts', 'tools/names.ts']);
  });

  it('exposes the same catalog functions as the package root', () => {
    const names = ['listMcpToolSchemas', 'getMcpToolRegistryMetadata', 'getMcpToolSchema', 'getGeneratedMcpTools',
      'isMcpToolAvailable', 'isMcpToolName', 'isMcpWriteToolName', 'MCP_ALL_TOOL_NAMES', 'MCP_WRITE_TOOL_NAMES'] as const;
    for (const name of names) {
      expect((catalogEntry as Record<string, unknown>)[name], name).to.equal((root as Record<string, unknown>)[name]);
    }
  });

  it('is published as the ./catalog subpath export', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      exports?: Record<string, unknown>;
    };
    expect(manifest.exports?.['./catalog']).to.deep.equal({
      types: './dist/catalog.d.ts',
      default: './dist/catalog.js',
    });
    expect(manifest.exports?.['.']).to.deep.equal({
      types: './dist/index.d.ts',
      default: './dist/index.js',
    });
  });
});
