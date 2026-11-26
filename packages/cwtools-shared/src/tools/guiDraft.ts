import path from 'path';
import type { HostServices } from '../host/hostServices';
import { throwIfAborted } from '../host/lsp';
import { resolveWorkspacePath } from '../safety/paths';
import { parseGuiFile, parsePdx, serializePosition, serializeSize, type PdxNode, type GuiElement } from '../editors/guiParser';
import { sha256Text } from './pdxWriteCore';
import { candidateTransactionWithHost, stageTextCandidateWithHost, textCandidateWithHost, type DomainWriteContext } from './pdxWrites';
import type { SharedToolResult } from './schema';

const SOURCE = 'cwtools-shared';
const FIELDS = new Set(['action','filePath','transactionId','line','x','y','width','height','validationPassed']);

interface GuiDraftData { success: boolean; action: string; transactionId?: string; filePath?: string; baseHash?: string; contentHash?: string; elements?: GuiElement[]; result?: unknown; error?: string }
function failure(code: string, message: string): SharedToolResult<GuiDraftData> { return { ok: false, status: 'error', source: SOURCE, error: { code, message } }; }
function success(data: GuiDraftData): SharedToolResult<GuiDraftData> { return { ok: true, status: 'ready', source: SOURCE, data }; }
function numberArg(args: Record<string, unknown>, key: string, min: number): number | undefined {
  const value=args[key]; if(value===undefined)return undefined;
  if(typeof value!=='number'||!Number.isFinite(value)||value<min||Math.abs(value)>1_000_000)throw new Error(`${key} must be a finite number between ${min} and 1000000.`);
  return value;
}
function findNode(nodes: readonly PdxNode[], line: number): PdxNode | undefined {
  for(const node of nodes){if(node.line===line&&node.children)return node;const nested=node.children===undefined?undefined:findNode(node.children,line);if(nested)return nested;}
  return undefined;
}
function replaceProperty(content: string, line: number, key: 'position'|'size', serialized: string): string {
  const target=findNode(parsePdx(content),line);if(target===undefined)throw new Error(`No GUI block exists at line ${line}.`);
  const eol=content.includes('\r\n')?'\r\n':'\n';const lines=content.split(/\r?\n/);const property=target.children!.find(node=>node.key===key&&node.children);
  if(property!==undefined){const indent=lines[property.line-1]?.match(/^\s*/)?.[0]??'';lines.splice(property.line-1,(property.endLine??property.line)-property.line+1,indent+serialized);return lines.join(eol);}
  if(target.endLine===undefined)throw new Error('The GUI block has no closing brace.');
  const indent=lines[target.line-1]?.match(/^\s*/)?.[0]??'';lines.splice(target.endLine-1,0,indent+'    '+serialized);return lines.join(eol);
}
function resolveGui(host: HostServices, input: unknown): { resolvedPath: string; relativePath: string } | SharedToolResult<GuiDraftData> {
  if(typeof input!=='string')return failure('invalid_arguments','filePath is required.');
  const resolved=resolveWorkspacePath(host.workspaceRoot,input);
  if(!resolved.ok||resolved.resolvedPath===undefined||resolved.relativePath===undefined||path.extname(resolved.resolvedPath).toLowerCase()!=='.gui')return failure('invalid_path','A workspace-contained .gui file is required.');
  return { resolvedPath: resolved.resolvedPath, relativePath: resolved.relativePath };
}
function elements(content: string): GuiElement[] { return parseGuiFile(content,new Map()); }
function findElement(content: string, line: number): GuiElement | undefined {
  const visit=(items: readonly GuiElement[]): GuiElement | undefined=>{for(const item of items){if(item.line===line)return item;const nested=visit(item.children);if(nested)return nested;}return undefined};
  return visit(elements(content));
}

/** Bounded GUI draft mutations over the shared validated candidate transaction. */
export async function guiDraftWithHost(host: HostServices,args: Record<string,unknown>,context?: DomainWriteContext): Promise<SharedToolResult> {
  throwIfAborted(context?.signal);
  const extra=Object.keys(args).filter(key=>!FIELDS.has(key));if(extra.length)return failure('invalid_arguments','Unsupported field(s): '+extra.join(', '));
  const action=args.action;
  if(action!=='begin'&&action!=='update'&&action!=='validate'&&action!=='commit'&&action!=='discard'&&action!=='status')return failure('invalid_arguments','Unknown gui_draft action.');
  if(action==='validate'&&args.filePath!==undefined){
    const resolved=resolveGui(host,args.filePath);if('ok' in resolved)return resolved;const fresh=await host.diagnostics.getDiagnostics({file:resolved.resolvedPath},{signal:context?.signal});if(fresh.status==='pending')return{ok:true,status:'loading',source:SOURCE,data:{success:false,action,transactionId:typeof args.transactionId==='string'?args.transactionId:undefined,filePath:resolved.relativePath,error:'Diagnostics are still loading; retry validation when fresh.'},warnings:['The GUI candidate remains active and has not been committed.']}
  }
  if(action==='status'&&args.filePath!==undefined){
    const resolved=resolveGui(host,args.filePath);if('ok' in resolved)return resolved;const candidate=textCandidateWithHost(host,resolved.resolvedPath);if(candidate===undefined)return failure('transaction_inactive','No active GUI candidate contains this file.');return success({success:true,action,transactionId:candidate.transactionId,filePath:resolved.relativePath,baseHash:candidate.baseHash,contentHash:candidate.contentHash,elements:elements(candidate.content)})
  }
  if(action==='validate'||action==='commit'||action==='discard'||action==='status'){
    return await candidateTransactionWithHost(host,{action,...(typeof args.transactionId==='string'?{transactionId:args.transactionId}:{}),...(typeof args.validationPassed==='boolean'?{validationPassed:args.validationPassed}:{})},context,'gui_draft');
  }
  const resolved=resolveGui(host,args.filePath);if('ok' in resolved)return resolved;
  if(action==='begin'){
    const begun=await candidateTransactionWithHost(host,{action:'begin'},context,'gui_draft');if(!begun.ok)return begun;
    try{
      const file=await host.filesystem.readTextFile(resolved.resolvedPath);if(!file.exists)throw new Error('GUI file does not exist.');
      const baseHash=sha256Text(file.content);const staged=stageTextCandidateWithHost(host,resolved.resolvedPath,file.content,baseHash,'gui_draft');
      return success({success:true,action,transactionId:staged.transactionId,filePath:resolved.relativePath,baseHash,contentHash:staged.contentHash,elements:elements(file.content)});
    }catch(error){await candidateTransactionWithHost(host,{action:'discard'},context,'gui_draft');return failure('draft_failed',error instanceof Error?error.message:String(error));}
  }
  try{
    if(!Number.isInteger(args.line)||(args.line as number)<1)throw new Error('line must identify the GUI block returned by begin.');
    const line=args.line as number;const candidate=textCandidateWithHost(host,resolved.resolvedPath);if(candidate===undefined)throw new Error('No active candidate contains this GUI file.');
    const current=findElement(candidate.content,line);if(current===undefined)throw new Error('The candidate GUI element is stale; begin a new draft.');
    const x=numberArg(args,'x',-1_000_000);const y=numberArg(args,'y',-1_000_000);const width=numberArg(args,'width',0);const height=numberArg(args,'height',0);
    if(x===undefined&&y===undefined&&width===undefined&&height===undefined)throw new Error('At least one position or size value is required.');
    let next=candidate.content;
    if(x!==undefined||y!==undefined)next=replaceProperty(next,line,'position',serializePosition(x??current.position.x,y??current.position.y));
    if(width!==undefined||height!==undefined)next=replaceProperty(next,line,'size',serializeSize(width??current.size.width,height??current.size.height,current.sizeUsesXY));
    const staged=stageTextCandidateWithHost(host,resolved.resolvedPath,next,candidate.baseHash,'gui_draft');
    return success({success:true,action,transactionId:staged.transactionId,filePath:resolved.relativePath,baseHash:candidate.baseHash,contentHash:staged.contentHash,elements:elements(next)});
  }catch(error){return failure('draft_failed',error instanceof Error?error.message:String(error));}
}