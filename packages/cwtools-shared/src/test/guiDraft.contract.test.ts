import { expect } from 'chai';
import * as fs from 'fs';import * as os from 'os';import * as path from 'path';
import { guiDraftWithHost } from '../tools/guiDraft';
import type { HostServices } from '../host/hostServices';
import type { GuiElement } from '../editors/guiParser';

interface DraftView { transactionId?: string; elements?: GuiElement[] }
function child(elements: GuiElement[], name: string): GuiElement { for(const item of elements){if(item.name===name)return item;const found=child(item.children,name);if(found!==undefined)return found;}throw new Error('missing element '+name) }
function hostFor(root: string, granted = true): HostServices {
  const resolve=(file:string)=>path.resolve(root,file);
  return {
    workspaceRoot:root,readonlyMode:!granted,writesEnabled:granted,allowedWriteTools:new Set(granted?['gui_draft']:[]),
    filesystem:{
      readTextFile:async(file:string)=>({content:fs.existsSync(resolve(file))?fs.readFileSync(resolve(file),'utf8'):'',hasBom:false,exists:fs.existsSync(resolve(file))}),
      writeTextFile:async(file:string,content:string)=>{fs.writeFileSync(resolve(file),content,'utf8')},
      list:async()=>[],glob:async()=>[],
    },
    lsp:{} as HostServices['lsp'],diagnostics:{} as HostServices['diagnostics'],now:()=>Date.now(),log:()=>{},
  };
}
describe('gui_draft contract',()=>{
  let root='';let file='';
  const source='containerWindowType = {\n  name = "root"\n  buttonType = {\n    name = "confirm"\n    position = { x = 1 y = 2 }\n    size = { width = 10 height = 20 }\n  }\n}\n';
  beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'gui-draft-'));file=path.join(root,'test.gui');fs.writeFileSync(file,source,'utf8')});
  afterEach(()=>{if(fs.existsSync(file))fs.unlinkSync(file);if(fs.existsSync(root))fs.rmdirSync(root)});
  it('updates an identified element in the candidate without touching disk',async()=>{
    const host=hostFor(root);const begun=await guiDraftWithHost(host,{action:'begin',filePath:'test.gui'});
    expect(begun.ok).eq(true);const data=begun.data as unknown as DraftView;const element=child(data.elements!,'confirm');
    const updated=await guiDraftWithHost(host,{action:'update',filePath:'test.gui',transactionId:data.transactionId,line:element.line,x:30,y:40,width:50,height:60});
    expect(updated.ok).eq(true);const next=updated.data as unknown as DraftView;const moved=child(next.elements!,'confirm');
    expect(moved.position).deep.eq({x:30,y:40});expect(moved.size).deep.eq({width:50,height:60});
    expect(fs.readFileSync(file,'utf8')).eq(source);
    const discarded=await guiDraftWithHost(host,{action:'discard',transactionId:data.transactionId});expect(discarded.ok).eq(true);
  });
  it('keeps the candidate active and disk unchanged while fresh diagnostics are pending',async()=>{
    const host=hostFor(root);
    host.diagnostics={getDiagnostics:async()=>({status:'pending'})} as unknown as HostServices['diagnostics'];
    const begun=await guiDraftWithHost(host,{action:'begin',filePath:'test.gui'});const data=begun.data as unknown as DraftView;
    const element=child(data.elements!,'confirm');
    await guiDraftWithHost(host,{action:'update',filePath:'test.gui',transactionId:data.transactionId,line:element.line,x:30});
    const validated=await guiDraftWithHost(host,{action:'validate',filePath:'test.gui',transactionId:data.transactionId});
    expect(validated.status).eq('loading');expect(validated.data).deep.include({success:false,action:'validate',transactionId:data.transactionId});
    expect(fs.readFileSync(file,'utf8')).eq(source);
    const status=await guiDraftWithHost(host,{action:'status',filePath:'test.gui',transactionId:data.transactionId});
    expect(status.ok).eq(true);expect(status.data).deep.include({transactionId:data.transactionId});
    await guiDraftWithHost(host,{action:'discard',transactionId:data.transactionId});
  });

  it('rejects stale element identities and ungranted writes',async()=>{
    const host=hostFor(root);const begun=await guiDraftWithHost(host,{action:'begin',filePath:'test.gui'});const data=begun.data as unknown as DraftView;
    const stale=await guiDraftWithHost(host,{action:'update',filePath:'test.gui',transactionId:data.transactionId,line:999,x:1});expect(stale.ok).eq(false);
    await guiDraftWithHost(host,{action:'discard',transactionId:data.transactionId});
    const denied=await guiDraftWithHost(hostFor(root,false),{action:'begin',filePath:'test.gui'});expect(denied.ok,JSON.stringify(denied)).eq(false);expect(fs.readFileSync(file,'utf8')).eq(source);
  });
});