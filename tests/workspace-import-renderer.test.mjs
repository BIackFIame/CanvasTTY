import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import {SettingsStore} from '../src/main/services/SettingsStore.ts';
import {WorkspaceArchive} from '../src/main/services/WorkspaceArchive.ts';
import {persistSettingsUpdate} from '../src/renderer/src/features/settings/persistSettings.ts';
import {importWithFakeReact,findAll,tick} from './helpers/fake-react.mjs';
const tools=await importWithFakeReact('src/renderer/src/features/workspace/WorkspaceBacklogTools.tsx','WorkspaceBacklogTools');
const app=await readFile(new URL('../src/renderer/src/App.tsx',import.meta.url),'utf8');
const canvas=await readFile(new URL('../src/renderer/src/features/workspace/WorkspaceCanvas.tsx',import.meta.url),'utf8');
const persistence=app.slice(app.indexOf('  const persistSettings = useCallback'),app.indexOf('  const saveSettings = useCallback'));
const importedCanvas={version:1,canvasRegions:[{id:'lane',title:'Imported lane',color:'#ABCDEF',position:{x:2,y:3},size:{width:900,height:600}}],
 stickyNotes:[{id:'note',text:'Imported note',position:{x:100,y:200},size:{width:320,height:220}}],browserCanvas:{position:{x:500,y:700},size:{width:900,height:620}}};
for(const failure of [false,true])test(`actual workspace import applies confirmed settings through App persistence (failure=${failure})`,async t=>{
 const directory=await mkdtemp(join(tmpdir(),'ctty-live-import-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=new SettingsStore(directory,'en','linux');await store.load();let live=store.get();const before=live;
 let imports=0,updates=0,updateWork;const archive=new WorkspaceArchive(directory,{descriptors:()=>[],create(){assert.fail('no cards in fixture');},setBounds(){},available:()=>true,redact:text=>text});
 const api={workspacePresets:async()=>[],previewImport:text=>archive.preview(text),importWorkspace:async text=>{imports++;return archive.import(text,false);}};
 const oldWindow=globalThis.window,oldDocument=globalThis.document;globalThis.document={body:{nodeType:1}};
 globalThis.window={setTimeout,clearTimeout,canvasTTY:{backlog:api,settings:{update:patch=>{updates++;updateWork=failure?Promise.reject(new Error('settings write failed')):store.update(patch);return updateWork;}}}};
 tools.__reset();t.after(()=>{tools.__unmount();globalThis.window=oldWindow;globalThis.document=oldDocument;});
 const persist=runInNewContext(stripTypeScriptTypes(`${persistence}\npersistSettings;`),{useCallback:fn=>fn,persistSettingsUpdate,window:globalThis.window,setSettings:value=>{live=value;}});
 assert.match(app,/<WorkspaceCanvas[\s\S]*?onPersistSettings=\{persistSettings\}/);
 assert.match(canvas,/<WorkspaceBacklogTools[\s\S]*?onPersistSettings=\{props.onPersistSettings\}/);
 const props={sessions:[],settings:live,locale:'en',broadcastEnabled:false,broadcastSending:false,broadcastTargetCount:0,onClose(){},onPersistSettings:persist};
 let tree;const render=()=>{tools.__flush();props.settings=live;tree=tools.__render(tools.WorkspaceBacklogTools,props);};render();await tick();render();
 const file=findAll(tree,node=>node.type==='input'&&node.props.type==='file')[0];
 file.props.onChange({currentTarget:{files:[{text:async()=>JSON.stringify({format:'canvastty-workspace',version:1,sessions:[],canvas:importedCanvas})}],value:'file'}});
 await tick();render();const restore=findAll(tree,node=>node.type==='button'&&node.props.children==='Restore snapshot')[0];assert.ok(restore);restore.props.onClick();
 await tick();assert.ok(updateWork,"import reached settings persistence");await updateWork.catch(()=>{});await tick();render();assert.equal(imports,1);assert.equal(updates,1);
 if(failure){assert.equal(live,before);assert.match(JSON.stringify(tree),/settings write failed/);assert.ok(findAll(tree,node=>node.type==='button'&&node.props.children==='Restore snapshot').length);}
 else {assert.deepEqual(live.canvasRegions,importedCanvas.canvasRegions);assert.deepEqual(live.stickyNotes,importedCanvas.stickyNotes);assert.deepEqual(live.browserCanvas,importedCanvas.browserCanvas);
  assert.equal(findAll(tree,node=>node.type==='button'&&node.props.children==='Restore snapshot').length,0);
  await persist({stickyNotes:live.stickyNotes.map(note=>({...note,text:'Later edit'}))});assert.equal(store.get().canvasRegions[0].title,'Imported lane');assert.equal(store.get().stickyNotes[0].text,'Later edit');}
});
