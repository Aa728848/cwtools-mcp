import { createHash } from 'crypto';

/**
 * Typed PDXScript mutation builders (pure text -> candidate content transforms).
 *
 * Shared by the MCP server and the VS Code agent so both surfaces accept exactly
 * the same operation vocabulary. Never performs I/O; the caller reads the file
 * and commits the returned candidate through the write pipeline. Every
 * operation is bounded and rejects raw code, unknown fields and duplicate
 * targets instead of guessing a match.
 */

export type PdxValue =
  | { kind: 'identifier' | 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'list'; values: PdxValue[] }
  | { kind: 'block'; entries: PdxEntry[] };

export interface PdxEntry {
  key: string;
  value: PdxValue;
}

export interface PdxPathSegment {
  key: string;
  occurrence: number;
}

export interface TypedPdxCandidate {
  filePath: string;
  beforeHash: string;
  contentHash: string;
  content: string;
  summary: string;
  targetRange: { start: number; end: number };
  operation: Record<string, unknown>;
  diff: { added: number; removed: number };
}

interface BlockSpan {
  key: string;
  /** Definition identity: the immediate `id = ...` when present, else the key. */
  symbol: string;
  start: number;
  open: number;
  close: number;
  end: number;
  indent: string;
  children: BlockSpan[];
}

interface CloneOverride {
  action: 'set' | 'delete' | 'append';
  path: PdxPathSegment[];
  value?: PdxValue;
  entry?: PdxEntry;
}

const MAX_DEPTH = 8;
const MAX_NODES = 256;
const MAX_TEXT = 4096;
const MAX_FILE_CHARS = 2_000_000;
const MAX_OVERRIDES = 64;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.:@-]*$/;
const INLINE_SCRIPT = /^[A-Za-z0-9_.:@/-]+$/;

function fail(message: string): never {
  throw new Error('typedPdxWrite: ' + message);
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function asRecordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(label + ' must be a PDX identifier');
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(record).filter(key => !allowed.includes(key));
  if (extra.length > 0) fail(label + ' contains unsupported field(s): ' + extra.join(', '));
}

function validateValue(value: unknown, depth = 0, state = { nodes: 0 }): asserts value is PdxValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PDX value must be an object');
  if (depth > MAX_DEPTH || ++state.nodes > MAX_NODES) fail('PDX value exceeds safety limits');
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case 'identifier':
      assertOnlyKeys(record, ['kind', 'value'], 'identifier value');
      assertIdentifier(record.value, 'identifier');
      return;
    case 'string':
      assertOnlyKeys(record, ['kind', 'value'], 'string value');
      if (typeof record.value !== 'string' || record.value.length > MAX_TEXT
        || [...record.value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) fail('invalid string value');
      return;
    case 'number':
      assertOnlyKeys(record, ['kind', 'value'], 'number value');
      if (typeof record.value !== 'number' || !Number.isFinite(record.value)) fail('invalid number value');
      return;
    case 'boolean':
      assertOnlyKeys(record, ['kind', 'value'], 'boolean value');
      if (typeof record.value !== 'boolean') fail('invalid boolean value');
      return;
    case 'list':
      assertOnlyKeys(record, ['kind', 'values'], 'list value');
      if (!Array.isArray(record.values)) fail('list values must be an array');
      if (record.values.length > MAX_NODES) fail('PDX value exceeds safety limits');
      for (const item of record.values) validateValue(item, depth + 1, state);
      return;
    case 'block':
      assertOnlyKeys(record, ['kind', 'entries'], 'block value');
      if (!Array.isArray(record.entries)) fail('block entries must be an array');
      validateEntries(record.entries, depth + 1, state);
      return;
    default:
      fail('unsupported PdxValue kind; raw code is forbidden');
  }
}

function validateEntries(entries: readonly unknown[], depth = 0, state = { nodes: 0 }): asserts entries is PdxEntry[] {
  if (entries.length > MAX_NODES) fail('PDX entries exceed safety limits');
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('invalid PDX entry');
    const record = entry as Record<string, unknown>;
    assertOnlyKeys(record, ['key', 'value'], 'PDX entry');
    assertIdentifier(record.key, 'PDX entry key');
    validateValue(record.value, depth, state);
  }
}

function validatePath(value: unknown, label: string): asserts value is PdxPathSegment[] {
  if (!Array.isArray(value) || value.length === 0) fail(label + ' path must be a non-empty array');
  if (value.length > MAX_DEPTH) fail(label + ' path exceeds safety limit');
  for (const segment of value) {
    const record = asRecordValue(segment);
    assertOnlyKeys(record, ['key', 'occurrence'], label + ' path segment');
    assertIdentifier(record.key, label + ' path key');
    if (record.occurrence !== undefined && (!Number.isSafeInteger(record.occurrence) || (record.occurrence as number) < 0)) {
      fail(label + ' path occurrence must be a non-negative integer');
    }
  }
}

function quote(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function renderValue(value: PdxValue, indent: string, newline: string, depth = 0): string {
  if (depth > MAX_DEPTH) fail('render depth exceeded');
  switch (value.kind) {
    case 'identifier': return value.value;
    case 'string': return quote(value.value);
    case 'number': return String(value.value);
    case 'boolean': return value.value ? 'yes' : 'no';
    case 'list': return '{ ' + value.values.map(item => renderValue(item, indent, newline, depth + 1)).join(' ') + ' }';
    case 'block': {
      if (value.entries.length === 0) return '{}';
      const childIndent = indent + '\t';
      return '{' + newline + value.entries
        .map(entry => childIndent + entry.key + ' = ' + renderValue(entry.value, childIndent, newline, depth + 1))
        .join(newline) + newline + indent + '}';
    }
  }
}
function skipTrivia(text: string, index: number): number {
  let i = index;
  while (i < text.length) {
    if (/\s/.test(text[i]!)) { i++; continue; }
    if (text[i] === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    break;
  }
  return i;
}

function readIdentifier(text: string, index: number): { value: string; end: number } | undefined {
  const match = /^[A-Za-z_][A-Za-z0-9_.:@-]*/.exec(text.slice(index));
  return match ? { value: match[0], end: index + match[0].length } : undefined;
}

function skipString(text: string, index: number): number {
  let i = index + 1;
  while (i < text.length && text[i] !== '"') {
    if (text[i] === '\\') i++;
    i++;
  }
  return Math.min(i + 1, text.length);
}

interface ScannedEntry { key: string; valueStart: number; valueEnd: number }

function scanEntries(text: string, block: BlockSpan): ScannedEntry[] {
  const entries: ScannedEntry[] = [];
  let index = block.open + 1;
  while (index < block.close) {
    index = skipTrivia(text, index);
    if (index >= block.close) break;
    const key = readIdentifier(text, index);
    if (!key) { index++; continue; }
    const afterKey = skipTrivia(text, key.end);
    if (text[afterKey] !== '=') { index = key.end; continue; }
    const valueStart = skipTrivia(text, afterKey + 1);
    let valueEnd = valueStart;
    if (text[valueStart] === '"') {
      valueEnd = skipString(text, valueStart);
    } else if (text[valueStart] === '{') {
      let depth = 0;
      while (valueEnd < block.close) {
        if (text[valueEnd] === '"') { valueEnd = skipString(text, valueEnd); continue; }
        if (text[valueEnd] === '#') { while (valueEnd < block.close && text[valueEnd] !== '\n') valueEnd++; continue; }
        if (text[valueEnd] === '{') depth++;
        else if (text[valueEnd] === '}') { depth--; if (depth === 0) { valueEnd++; break; } }
        valueEnd++;
      }
    } else {
      while (valueEnd < block.close && !/[\s}#]/.test(text[valueEnd]!)) valueEnd++;
    }
    entries.push({ key: key.value, valueStart, valueEnd });
    index = Math.max(valueEnd, key.end);
  }
  return entries;
}

function readQuoted(text: string, start: number, limit: number): string | undefined {
  let value = '';
  for (let i = start + 1; i < limit; i++) {
    const char = text[i];
    if (char === '\\') {
      const next = text[++i];
      if (next === undefined) return undefined;
      value += next;
    } else if (char === '"') {
      return value;
    } else {
      value += char;
    }
  }
  return undefined;
}

/**
 * Definition identity for `kind = { id = name }` blocks (events, on_actions).
 * Only immediate children count, so a nested `id` cannot rename the outer block.
 */
function immediateId(text: string, open: number, close: number): string | undefined {
  let depth = 0;
  let quoted = false;
  let comment = false;
  for (let i = open + 1; i < close; i++) {
    const char = text[i]!;
    if (comment) { if (char === '\n') comment = false; continue; }
    if (quoted) { if (char === '\\') i++; else if (char === '"') quoted = false; continue; }
    if (char === '"') { quoted = true; continue; }
    if (char === '#') { comment = true; continue; }
    if (char === '{') { depth++; continue; }
    if (char === '}') { depth--; continue; }
    if (depth !== 0) continue;
    const key = readIdentifier(text, i);
    if (!key) continue;
    i = skipTrivia(text, key.end);
    if (text[i] !== '=') continue;
    i = skipTrivia(text, i + 1);
    if (key.value !== 'id') continue;
    if (text[i] === '"') return readQuoted(text, i, close);
    return readIdentifier(text, i)?.value;
  }
  return undefined;
}

function scanBlocks(text: string): BlockSpan[] {
  const visit = (start: number, end: number): BlockSpan[] => {
    const found: BlockSpan[] = [];
    let index = start;
    while (index < end) {
      index = skipTrivia(text, index);
      if (index >= end) break;
      const key = readIdentifier(text, index);
      if (!key) { index++; continue; }
      const afterKey = skipTrivia(text, key.end);
      const valueStart = text[afterKey] === '=' ? skipTrivia(text, afterKey + 1) : afterKey;
      if (text[valueStart] !== '{') {
        // A scalar assignment is not a definition; step past it so a following
        // block is not mistaken for one.
        let cursor = valueStart;
        while (cursor < end && text[cursor] !== '\n' && text[cursor] !== '}') {
          cursor = text[cursor] === '"' ? skipString(text, cursor) : cursor + 1;
        }
        index = Math.max(cursor, key.end);
        continue;
      }
      let depth = 0;
      let close = valueStart;
      while (close < end) {
        if (text[close] === '"') { close = skipString(text, close); continue; }
        if (text[close] === '#') { while (close < end && text[close] !== '\n') close++; continue; }
        if (text[close] === '{') depth++;
        else if (text[close] === '}') { depth--; if (depth === 0) break; }
        close++;
      }
      if (close >= end) break;
      const lineStart = text.lastIndexOf('\n', index - 1) + 1;
      const indent = /^[ \t]*/.exec(text.slice(lineStart, index))?.[0] ?? '';
      found.push({
        key: key.value,
        symbol: immediateId(text, valueStart, close) ?? key.value,
        start: lineStart,
        open: valueStart,
        close,
        end: close + 1,
        indent,
        children: visit(valueStart + 1, close),
      });
      index = close + 1;
    }
    return found;
  };
  return visit(0, text.length);
}

function findUnique(blocks: readonly BlockSpan[], name: string, label: string): BlockSpan {
  const matches = blocks.filter(block => block.key === name || block.symbol === name);
  if (matches.length === 0) fail('could not find ' + label + ': ' + name);
  if (matches.length > 1) fail('ambiguous ' + label + ': ' + name + ' appears ' + matches.length + ' times');
  return matches[0]!;
}

function findContainer(root: BlockSpan, containerPath: readonly unknown[] | undefined): BlockSpan {
  if (containerPath !== undefined && !Array.isArray(containerPath)) fail('containerPath must be an array');
  if ((containerPath?.length ?? 0) > MAX_DEPTH) fail('containerPath exceeds safety limit');
  let current = root;
  for (const segment of containerPath ?? []) {
    if (typeof segment !== 'string') fail('containerPath segment must be a string');
    current = findUnique(current.children, segment, 'container');
  }
  return current;
}

function appendEntry(text: string, block: BlockSpan, entry: PdxEntry, newline: string): string {
  const childIndent = block.indent + '\t';
  const rendered = childIndent + entry.key + ' = ' + renderValue(entry.value, childIndent, newline);
  const closeLineStart = text.lastIndexOf('\n', block.close - 1) + 1;
  return text.slice(0, closeLineStart) + rendered + newline + text.slice(closeLineStart);
}

function applyPathEntry(
  text: string,
  root: BlockSpan,
  path: readonly PdxPathSegment[],
  action: 'set' | 'delete' | 'append',
  value: PdxValue | PdxEntry | undefined,
  newline: string,
): string {
  let current = root;
  for (let index = 0; index < path.length - 1; index++) {
    current = findUnique(current.children, path[index]!.key, 'container');
  }
  const last = path[path.length - 1]!;
  const occurrence = last.occurrence ?? 0;
  const target = scanEntries(text, current).filter(entry => entry.key === last.key)[occurrence];
  if (action === 'set') {
    if (!target) fail('could not find field ' + last.key + ' (occurrence ' + occurrence + ')');
    const rendered = renderValue(value as PdxValue, current.indent + '\t', newline);
    return text.slice(0, target.valueStart) + rendered + text.slice(target.valueEnd);
  }
  if (action === 'delete') {
    if (!target) fail('could not find field ' + last.key + ' (occurrence ' + occurrence + ')');
    const lineStart = text.lastIndexOf('\n', target.valueStart - 1) + 1;
    if (/^[ \t]*[A-Za-z_][A-Za-z0-9_.:@-]*[ \t]*=/.test(text.slice(lineStart, target.valueStart))) {
      // The field starts its own line: drop the whole line, not just the value.
      const lineEnd = text.indexOf('\n', target.valueEnd);
      const cut = lineEnd === -1 ? text.length : lineEnd + 1;
      return text.slice(0, lineStart) + text.slice(cut);
    }
    return text.slice(0, target.valueStart) + text.slice(target.valueEnd);
  }
  if (target && text[target.valueStart] !== '{') {
    fail('add_definition_field target ' + last.key + ' is not a block');
  }
  return appendEntry(text, current, value as PdxEntry, newline);
}

function validateOverride(override: unknown): asserts override is CloneOverride {
  const record = asRecordValue(override);
  assertOnlyKeys(record, ['action', 'path', 'value', 'entry'], 'clone override');
  if (record.action !== 'set' && record.action !== 'delete' && record.action !== 'append') fail('unsupported clone override action');
  validatePath(record.path, 'clone override');
  if (record.action === 'set') validateValue(record.value);
  if (record.action === 'append') validateEntries([record.entry]);
}

function countChangedLines(before: string, after: string): { added: number; removed: number } {
  const beforeLines = before.split(/\r?\n/).length;
  const afterLines = after.split(/\r?\n/).length;
  return { added: Math.max(0, afterLines - beforeLines), removed: Math.max(0, beforeLines - afterLines) };
}
export function buildTypedPdxCandidate(
  filePath: string,
  text: string,
  operation: Record<string, unknown>,
  expectedHash?: string,
): TypedPdxCandidate {
  if (!filePath.toLowerCase().endsWith('.txt')) fail('only .txt files are supported');
  if (typeof text !== 'string' || text.length > MAX_FILE_CHARS) fail('file is missing or oversized');
  const beforeHash = sha256Text(text);
  if (expectedHash !== undefined && expectedHash !== beforeHash) fail('expectedHash does not match current content');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const blocks = scanBlocks(text);
  const kind = typeof operation.operation === 'string' ? operation.operation : '';
  let target: BlockSpan;
  let content: string;
  let summary: string;

  if (kind === 'clone_definition') {
    assertOnlyKeys(operation, ['operation', 'source', 'newSymbol', 'overrides'], 'clone_definition');
    const source = operation.source;
    assertIdentifier(source, 'source');
    target = findUnique(blocks, source, 'source');
    assertIdentifier(operation.newSymbol, 'newSymbol');
    if (blocks.some(block => block.key === operation.newSymbol || block.symbol === operation.newSymbol)) fail('duplicate target: ' + operation.newSymbol);
    const overrides = operation.overrides ?? [];
    if (!Array.isArray(overrides)) fail('clone_definition overrides must be an array');
    if (overrides.length > MAX_OVERRIDES) fail('clone_definition supports at most ' + MAX_OVERRIDES + ' overrides');
    for (const override of overrides) validateOverride(override);
    let clone = text.slice(target.start, target.end);
    let cloneRoot = scanBlocks(clone)[0];
    if (!cloneRoot) fail('could not scan cloned definition');
    const identity = scanEntries(clone, cloneRoot).find(entry => entry.key === 'id');
    if (identity) {
      const current = clone.slice(identity.valueStart, identity.valueEnd);
      if (current !== (current.startsWith('"') ? quote(source) : source)) fail('could not rewrite id field for ' + source);
      const replacement = current.startsWith('"') ? quote(operation.newSymbol) : operation.newSymbol;
      clone = clone.slice(0, identity.valueStart) + replacement + clone.slice(identity.valueEnd);
    } else {
      const sourceName = readIdentifier(clone, 0);
      if (!sourceName || sourceName.value !== source) fail('could not rewrite definition key');
      clone = operation.newSymbol + clone.slice(sourceName.end);
    }
    for (const override of overrides as CloneOverride[]) {
      cloneRoot = scanBlocks(clone)[0];
      if (!cloneRoot) fail('could not rescan cloned definition');
      clone = applyPathEntry(clone, cloneRoot, override.path, override.action, override.value ?? override.entry, newline);
    }
    const tail = /^[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/.exec(text.slice(target.end))?.[0] ?? '';
    const insertion = target.end + tail.length;
    const separator = insertion > 0 && (text[insertion - 1] === '\n' || text[insertion - 1] === '\r') ? '' : newline;
    const suffix = text.slice(insertion);
    const trailingSeparator = suffix.length > 0 || text.endsWith(newline) ? newline : '';
    content = text.slice(0, insertion) + separator + clone + trailingSeparator + suffix;
    summary = 'cloned ' + source + ' as ' + operation.newSymbol;
  } else {
    assertIdentifier(operation.target, 'target');
    target = findUnique(blocks, operation.target, 'target');
    if (kind === 'add_event_call') {
      assertOnlyKeys(operation, ['operation', 'target', 'callType', 'eventId', 'containerPath', 'days'], 'add_event_call');
      assertIdentifier(operation.callType, 'callType');
      assertIdentifier(operation.eventId, 'eventId');
      if (operation.days !== undefined && (!Number.isSafeInteger(operation.days) || (operation.days as number) < 0)) {
        fail('days must be a non-negative integer');
      }
      const entries: PdxEntry[] = [{ key: 'id', value: { kind: 'identifier', value: operation.eventId } }];
      if (operation.days !== undefined) entries.push({ key: 'days', value: { kind: 'number', value: operation.days as number } });
      content = appendEntry(text, findContainer(target, operation.containerPath as unknown[] | undefined), {
        key: operation.callType,
        value: { kind: 'block', entries },
      }, newline);
      summary = 'added ' + operation.callType + ' call to ' + operation.eventId;
    } else if (kind === 'add_event_option') {
      assertOnlyKeys(operation, ['operation', 'target', 'name', 'fields'], 'add_event_option');
      assertIdentifier(operation.name, 'option name');
      const fields = (operation.fields ?? []) as unknown[];
      validateEntries(fields);
      if (text.slice(target.open, target.close).includes('name = ' + operation.name)) fail('duplicate option name: ' + operation.name);
      content = appendEntry(text, target, {
        key: 'option',
        value: { kind: 'block', entries: [{ key: 'name', value: { kind: 'identifier', value: operation.name } }, ...(fields as PdxEntry[])] },
      }, newline);
      summary = 'added option ' + operation.name + ' to ' + operation.target;
    } else if (kind === 'append_trigger_condition') {
      assertOnlyKeys(operation, ['operation', 'target', 'condition', 'containerPath'], 'append_trigger_condition');
      const conditions: unknown[] = [operation.condition];
      validateEntries(conditions);
      const condition = conditions[0]!;
      content = appendEntry(text, findContainer(target, (operation.containerPath as unknown[] | undefined) ?? ['trigger']), condition, newline);
      summary = 'appended trigger condition ' + condition.key;
    } else if (kind === 'instantiate_inline_script') {
      assertOnlyKeys(operation, ['operation', 'target', 'script', 'arguments', 'containerPath'], 'instantiate_inline_script');
      if (typeof operation.script !== 'string' || !INLINE_SCRIPT.test(operation.script)) {
        fail('inline script must be a safe project-relative identifier');
      }
      const argumentsList = (operation.arguments ?? []) as unknown[];
      validateEntries(argumentsList);
      content = appendEntry(text, findContainer(target, operation.containerPath as unknown[] | undefined), {
        key: 'inline_script',
        value: { kind: 'block', entries: [
          { key: 'script', value: { kind: 'string', value: operation.script } },
          ...(argumentsList as PdxEntry[]),
        ] },
      }, newline);
      summary = 'instantiated inline script ' + operation.script;
    } else if (kind === 'set_definition_field' || kind === 'delete_definition_field' || kind === 'add_definition_field') {
      const allowed = kind === 'set_definition_field'
        ? ['operation', 'target', 'path', 'value']
        : kind === 'delete_definition_field'
          ? ['operation', 'target', 'path']
          : ['operation', 'target', 'path', 'entry'];
      assertOnlyKeys(operation, allowed, kind);
      const pathValue = operation.path;
      validatePath(pathValue, kind);
      if (kind === 'set_definition_field') {
        const fieldValue = operation.value;
        validateValue(fieldValue);
        content = applyPathEntry(text, target, pathValue, 'set', fieldValue, newline);
        summary = 'set field on ' + operation.target;
      } else if (kind === 'delete_definition_field') {
        content = applyPathEntry(text, target, pathValue, 'delete', undefined, newline);
        summary = 'deleted field from ' + operation.target;
      } else {
        const fieldEntries: unknown[] = [operation.entry];
        validateEntries(fieldEntries);
        const fieldEntry = fieldEntries[0]!;
        content = applyPathEntry(text, target, pathValue, 'append', fieldEntry, newline);
        summary = 'added field ' + fieldEntry.key + ' to ' + operation.target;
      }
    } else if (kind === 'add_scripted_effect_call' || kind === 'add_scripted_trigger_call') {
      assertOnlyKeys(operation, ['operation', 'target', 'script', 'arguments', 'containerPath'], kind);
      assertIdentifier(operation.script, 'script');
      const argumentsList = (operation.arguments ?? []) as unknown[];
      validateEntries(argumentsList);
      content = appendEntry(text, findContainer(target, operation.containerPath as unknown[] | undefined), {
        key: operation.script,
        value: { kind: 'block', entries: argumentsList as PdxEntry[] },
      }, newline);
      summary = 'added ' + (kind === 'add_scripted_effect_call' ? 'scripted effect' : 'scripted trigger') + ' call ' + operation.script;
    } else if (kind === 'add_on_action_entry') {
      assertOnlyKeys(operation, ['operation', 'target', 'entry'], 'add_on_action_entry');
      const onActionEntries: unknown[] = [operation.entry];
      validateEntries(onActionEntries);
      const onActionEntry = onActionEntries[0]!;
      if (onActionEntry.key === 'id') fail('add_on_action_entry cannot append identity');
      content = appendEntry(text, target, onActionEntry, newline);
      summary = 'added on-action entry ' + onActionEntry.key;
    } else if (kind === 'bind_event_target' || kind === 'clear_event_target') {
      assertOnlyKeys(operation, ['operation', 'target', 'eventTarget', 'containerPath'], kind);
      assertIdentifier(operation.eventTarget, 'eventTarget');
      content = appendEntry(text, findContainer(target, operation.containerPath as unknown[] | undefined), {
        key: kind === 'bind_event_target' ? 'save_event_target_as' : 'clear_event_target',
        value: { kind: 'identifier', value: operation.eventTarget },
      }, newline);
      summary = (kind === 'bind_event_target' ? 'bound' : 'cleared') + ' event target ' + operation.eventTarget;
    } else if (kind === 'add_variable_transition') {
      assertOnlyKeys(operation, ['operation', 'target', 'transition', 'variable', 'value', 'containerPath'], 'add_variable_transition');
      const transition = String(operation.transition);
      if (!['set_variable', 'change_variable', 'multiply_variable', 'divide_variable'].includes(transition)) {
        fail('unsupported variable transition');
      }
      assertIdentifier(operation.variable, 'variable');
      validateValue(operation.value);
      content = appendEntry(text, findContainer(target, operation.containerPath as unknown[] | undefined), {
        key: transition,
        value: { kind: 'block', entries: [
          { key: 'which', value: { kind: 'identifier', value: operation.variable } },
          { key: 'value', value: operation.value },
        ] },
      }, newline);
      summary = 'added ' + transition + ' transition for ' + operation.variable;
    } else {
      fail('unsupported typed PDX operation; raw code is forbidden');
    }
  }

  return {
    filePath,
    beforeHash,
    contentHash: sha256Text(content),
    content,
    summary,
    targetRange: { start: target.start, end: target.end },
    operation,
    diff: countChangedLines(text, content),
  };
}