import * as fs from 'fs';
import * as path from 'path';

export interface ModDescriptor {
  exists: boolean;
  name?: string;
  version?: string;
  tags?: string[];
  supportedVersion?: string;
  remoteFileId?: string;
  dependencies?: string[];
  warnings?: string[];
}

/** Read descriptor.mod without throwing; malformed or unreadable fields become warnings. */
export function readDescriptor(root: string): ModDescriptor {
  const descriptorPath = path.join(root, 'descriptor.mod');
  if (!fs.existsSync(descriptorPath)) return { exists: false };
  let content: string;
  try {
    content = fs.readFileSync(descriptorPath, 'utf8');
  } catch {
    return { exists: true, warnings: ['descriptor.mod is not readable; treating it as absent.'] };
  }
  const warnings: string[] = [];
  const name = content.match(/^name\s*=\s*"?([^"\r\n]+)"?/m)?.[1]?.trim();
  const version = content.match(/^version\s*=\s*"?([^"\r\n]+)"?/m)?.[1]?.trim();
  const supportedVersion = content.match(/^supported_version\s*=\s*"?([^"\r\n]+)"?/m)?.[1]?.trim();
  const remoteFileId = content.match(/^remote_file_id\s*=\s*"?(\d+)"?/m)?.[1]?.trim();
  const tagsBlock = content.match(/^tags\s*=\s*\{([\s\S]*?)\}/m)?.[1] ?? '';
  const tags = Array.from(tagsBlock.matchAll(/"([^"]+)"/g)).map(match => match[1]).filter((tag): tag is string => !!tag);
  const dependenciesBlock = content.match(/^dependencies\s*=\s*\{([\s\S]*?)\}/m)?.[1] ?? '';
  const dependencies = Array.from(dependenciesBlock.matchAll(/"([^"]+)"/g))
    .map(match => match[1]).filter((value): value is string => !!value)
    .filter((value, index, values) => values.indexOf(value) === index);
  if (content.includes('supported_version') && !supportedVersion) warnings.push('descriptor.mod declares supported_version but it could not be parsed.');
  if (content.includes('remote_file_id') && !remoteFileId) warnings.push('descriptor.mod declares remote_file_id but it could not be parsed.');
  if (content.includes('dependencies') && dependencies.length === 0) warnings.push('descriptor.mod declares dependencies but none could be parsed.');
  return { exists: true, name, version, tags, supportedVersion, remoteFileId, dependencies, warnings };
}
