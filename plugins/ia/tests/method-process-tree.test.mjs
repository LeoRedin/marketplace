import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeMethodProcess } from '../scripts/lib/method-process.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('inherited mode refuses a POSIX caller that does not lead its process group',{skip:process.platform==='win32'},async t=>{
 const root=mkdtempSync(join(tmpdir(),'service-process-leader-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const worker=join(root,'worker.mjs'),argv=[process.execPath,'-e',"require('fs').writeFileSync('started','')"];
 writeFileSync(worker,`import{executeMethodProcess}from ${JSON.stringify(new URL('../scripts/lib/method-process.mjs',import.meta.url).href)};try{const result=await executeMethodProcess({argv:${JSON.stringify(argv)},cwd:${JSON.stringify(root)},directory:${JSON.stringify(root)},timeoutSeconds:5,processGroup:'inherited',env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''}});process.stdout.write(JSON.stringify(result));}catch(error){process.stdout.write(error.message);}`);
 // Not detached: the worker joins this process's group and does not lead one.
 assert.match(childProcess.execFileSync(process.execPath,[worker],{cwd:root,encoding:'utf8',env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''}}),/requires the caller to lead its process group/);
 assert.equal(existsSync(join(root,'started')),false);assert.equal(existsSync(join(root,'stdout.bin')),false);
});
for(const mode of ['timeout','overflow','stream-error','child-error','root-death','inner-timeout'])test(`supervised outer ${mode} stops real nested descendants`,{skip:mode==='root-death'&&process.platform==='win32'},async t=>{
 const failure=mode==='stream-error'||mode==='child-error',root=mkdtempSync(join(tmpdir(),'service-process-tree-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const inner=join(root,'inner');mkdirSync(inner);
 const pulse=join(root,'pulse'),pidFile=join(root,'pid');
 const leaf=join(root,'leaf.mjs'),worker=join(root,'worker.mjs');
 writeFileSync(leaf,`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>writeFileSync(${JSON.stringify(pulse)},String(Date.now())),30);`);
 const module=new URL('../scripts/lib/method-process.mjs',import.meta.url).href;
 writeFileSync(worker,`import{executeMethodProcess}from ${JSON.stringify(module)};${mode==='overflow'?"setTimeout(()=>process.stdout.write('x'.repeat(100000)),1000);":''}const result=await executeMethodProcess({argv:[process.execPath,${JSON.stringify(leaf)}],cwd:${JSON.stringify(root)},directory:${JSON.stringify(inner)},timeoutSeconds:${mode==='inner-timeout'?1:30},processGroup:'inherited',env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''}});process.stdout.write(JSON.stringify(result));`);
 const originalSpawn=childProcess.spawn;
 if(failure||mode==='root-death'){childProcess.spawn=(...args)=>{const child=originalSpawn(...args);setTimeout(()=>mode==='root-death'?child.kill('SIGKILL'):mode==='child-error'?child.emit('error',new Error('injected child failure')):child.stdout.emit('error',new Error('injected pipe failure')),1000);return child;};syncBuiltinESMExports();}
 const termination=[];
 const started=Date.now();let result,error;try{result=await executeMethodProcess({argv:[process.execPath,worker],cwd:root,directory:root,timeoutSeconds:mode==='inner-timeout'?5:failure?15:3,outputLimit:65536,env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''},onTerminationDiagnostic:row=>termination.push(row)});}catch(caught){error=caught;}finally{childProcess.spawn=originalSpawn;syncBuiltinESMExports();}
 // Capture evidence before assertions or fixture deletion can hide a live descendant.
 const observe=()=>{let pid=null,heartbeat=null,alive=null;try{pid=Number(readFileSync(pidFile,'utf8'));}catch{}try{heartbeat=readFileSync(pulse,'utf8');}catch{}if(Number.isSafeInteger(pid)&&pid>0){try{process.kill(pid,0);alive=true;}catch(error){alive=error.code==='ESRCH'?false:null;}}return{pid,heartbeat,alive};};
 const observedBefore=observe();await sleep(300);const observedAfter=observe();
 t.diagnostic(JSON.stringify({mode,termination,supervisor:result?.supervisor,terminationFailed:result?.terminationFailed,observedBefore,observedAfter}));
 // An error path must reject, and its own cleanup, not the outer timeout, must stop the tree.
 if(failure){assert.match(error?.message??'',mode==='child-error'?/injected child failure/:/injected pipe failure/);assert.ok(Date.now()-started<10000,'error path terminated before the outer timeout');}else assert.equal(error,undefined);
 if(mode==='root-death'||(mode==='inner-timeout'&&process.platform!=='win32'))assert.equal(result.signal,'SIGKILL');
 if(mode==='root-death')assert.equal(result.descendantsTerminated,true);
 if(mode==='inner-timeout'&&process.platform==='win32'){assert.equal(result.exitCode,0);assert.equal(JSON.parse(readFileSync(join(root,'stdout.bin'),'utf8')).timedOut,true);}
 if(!failure&&mode!=='root-death'&&mode!=='inner-timeout'){assert.equal(result.terminationFailed,false);assert.equal(mode==='timeout'?result.timedOut:result.outputLimitExceeded,true);}
 assert.ok(existsSync(pidFile),'descendant actually started');const before=readFileSync(pulse,'utf8');await sleep(300);assert.equal(readFileSync(pulse,'utf8'),before,'descendant heartbeat stopped');
 const pid=Number(readFileSync(pidFile,'utf8'));
 if(process.platform==='win32')assert.throws(()=>process.kill(pid,0),/ESRCH/);
 t.diagnostic(JSON.stringify({mode,pid,supervisor:result?.supervisor,heartbeatStopped:true}));
});
