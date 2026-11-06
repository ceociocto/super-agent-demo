/**
 * Rebuild the editable talk from public/share/slides.json.
 * Requires the Codex bundled @oai/artifact-tool and presentation validators.
 * Set RUNTIME_NODE_MODULES, RUNTIME_PYTHON, PRESENTATION_SKILL_DIR;
 * optional TALK_FONT (default PingFang SC, must be installed).
 * Run with the bundled Node executable. Outputs a validated PPTX and previews.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = process.env.RUNTIME_NODE_MODULES;
const skill = process.env.PRESENTATION_SKILL_DIR;
const python = process.env.RUNTIME_PYTHON;
if (!modules || !skill || !python) throw new Error('Set RUNTIME_NODE_MODULES, PRESENTATION_SKILL_DIR and RUNTIME_PYTHON to the bundled runtime paths.');
const { Presentation, PresentationFile } = await import(pathToFileURL(path.join(modules, '@oai/artifact-tool/dist/artifact_tool.mjs')).href);
const { finalizePresentation } = await import(pathToFileURL(path.join(skill, 'container_tools/artifact_tool_utils.mjs')).href);
const font = process.env.TALK_FONT || 'PingFang SC';
const data = JSON.parse(await fs.readFile(path.join(root, 'public/share/slides.json'), 'utf8'));
if (data.slides.length !== 14 || data.slides.some(s => !s.notes)) throw new Error('Expected 14 slides with speaker notes.');
const build = path.join(root, 'work/local-team/share-build', new Date().toISOString().replace(/[:.]/g, '-'));
await fs.mkdir(build, { recursive: true });
await fs.mkdir(path.join(build,'output'), { recursive: true });
const ppt = Presentation.create({ slideSize: { width: 1280, height: 720 } });
const C={ink:'#17243E',muted:'#526078',blue:'#475CE9',pale:'#F0F3FF',line:'#DDE3F0',green:'#168064'};
function rect(s,x,y,w,h,color){return s.shapes.add({geometry:'rect',position:{left:x,top:y,width:w,height:h},fill:color,line:{fill:'none',width:0}});}
function text(s,value,x,y,w,h,size=28,color=C.ink,bold=false,alignment='left'){
 const shape=s.shapes.add({geometry:'textbox',position:{left:x,top:y,width:w,height:h},fill:'none',line:{fill:'none',width:0}});
 shape.text=String(value);shape.text.style={fontSize:size,typeface:font,color,bold,alignment,verticalAlignment:'top',autoFit:'none',wrap:'square',insets:0};return shape;
}
function arrow(s,x,y,w=28){s.shapes.add({geometry:'rightArrow',position:{left:x,top:y,width:w,height:22},fill:C.blue,line:{fill:'none',width:0}});}
for(let index=0;index<data.slides.length;index++){
 const d=data.slides[index],s=ppt.slides.add();s.background.fill='#FFFFFF';
 rect(s,64,52,44,5,C.blue);
 text(s,d.kicker||'内部技术分享',124,40,1000,32,18,C.muted);
 text(s,d.title,64,104,1152,124,d.layout==='cover'?54:43,C.ink,true);
 text(s,d.summary||'',64,236,1152,72,27,C.muted);
 const n=d.items.length;
 if(d.layout==='cover'){
  d.items.forEach((it,i)=>{const x=64+i*(1152/n);rect(s,x,364,1152/n-32,4,C.blue);text(s,it.title,x,392,1152/n-36,64,31,C.ink,true);text(s,it.body,x,466,1152/n-36,100,24,C.muted);});
 }else if(['flow','timeline','demo'].includes(d.layout)){
  const gap=44,w=(1152-gap*(n-1))/n;
  d.items.forEach((it,i)=>{const x=64+i*(w+gap);text(s,String(i+1).padStart(2,'0'),x,340,w,70,52,C.blue,true);rect(s,x,424,w,3,C.line);text(s,it.title,x,450,w,76,28,C.ink,true);text(s,it.body,x,532,w,99,23,C.muted);if(i<n-1)arrow(s,x+w+8,372);});
 }else if(d.layout==='metrics'){
  const w=1152/n;
  d.items.forEach((it,i)=>{const x=64+i*w; text(s,it.title,x,368,w-32,120,58,C.blue,true);text(s,it.body,x,510,w-18,110,26,C.muted);});
 }else{
  const cols=n>3?2:n,rows=Math.ceil(n/cols),w=1152/cols,h=rows===2?156:272;
  d.items.forEach((it,i)=>{const x=64+(i%cols)*w,y=340+Math.floor(i/cols)*h;rect(s,x,y,4,rows===2?114:210,C.blue);text(s,it.title,x+22,y,w-52,64,31,C.ink,true);text(s,it.body,x+22,y+72,w-52,rows===2?70:130,25,C.muted);});
 }
 rect(s,64,675,1152,1,C.line);text(s,'Superagent / 内部技术分享',64,689,750,22,14,C.muted);text(s,`${String(index+1).padStart(2,'0')} / 14`,1100,688,116,24,16,C.muted,false,'right');
 s.speakerNotes.text=`${d.title}\n建议用时：${d.seconds} 秒\n\n${d.notes}\n\n来源\n${(d.sources||[]).map(x=>`${x.title}: ${x.url}`).join('\n')}`;
}
const candidate=path.join(build,'candidate.pptx');await (await PresentationFile.exportPptx(ppt)).save(candidate);
const finalPath=path.join(build,'output','superagent-internal-talk.pptx');
await finalizePresentation({workspaceDir:root,candidatePath:candidate,finalPath,pythonExecutable:python,integrityValidatorPath:path.join(skill,'container_tools/inspect_presentation_package_integrity.py'),layoutValidatorPath:path.join(skill,'container_tools/inspect_presentation_layout_geometry.py'),layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-bullet-geometry','--validate-heading-fit'],explicitTotalSlideCount:14,requiredNativeTableOwnerSlides:[],requiredNativeChartOwnerSlides:[],fontPolicy:{basis:'design',families:[font]},verifyArtifactToolImport:true,receiptPath:path.join(build,'validation.json')});
for(let i=0;i<ppt.slides.items.length;i++){
 const png=await ppt.export({slide:ppt.slides.items[i],format:'png',scale:1});
 await fs.writeFile(path.join(build,`slide-${String(i+1).padStart(2,'0')}.png`),new Uint8Array(await png.arrayBuffer()));
}
await fs.copyFile(finalPath,path.join(root,'public/share/superagent-internal-talk.pptx'));
console.log(JSON.stringify({slides:14,build,output:'public/share/superagent-internal-talk.pptx'}));
