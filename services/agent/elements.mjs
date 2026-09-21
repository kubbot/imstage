// Source-derived element measurements. No dataset answers or task-specific coordinates.
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright';
import {readScreenshotText} from './ocr.mjs';
import {FONT_STACK} from '../../packages/renderer/editPlanHtml.mjs';
const cache=new Map();
export const revisionOf=r=>createHash('sha256').update(JSON.stringify({plan:r.plan,assets:r.assets.map(a=>[a.id,createHash('sha256').update(a.dataUrl).digest('hex')])})).digest('hex').slice(0,16);
const hex=rgb=>'#'+rgb.map(n=>Math.round(n).toString(16).padStart(2,'0')).join('');
const median=a=>a.sort((x,y)=>x-y)[Math.floor(a.length/2)]||0;
export const normalizeRect=(r,w,h)=>[r[0]/w*1000,r[1]/h*1000,r[2]/w*1000,r[3]/h*1000];
export const pixelRect=(b,w,h)=>[b[0]*w/1000,b[1]*h/1000,b[2]*w/1000,b[3]*h/1000];
function colors(data,w,h,c,rect){
 const [x,y,rw,rh]=rect.map(Math.round),samples=[];
 const at=(x,y)=>Array.from(data.subarray((y*w+x)*c,(y*w+x)*c+3));
 for(let yy=Math.max(0,y-4);yy<Math.min(h,y+rh+4);yy+=2)for(let xx=Math.max(0,x-3);xx<Math.min(w,x+rw+3);xx+=2){if(xx<x+2||xx>x+rw-3||yy<y+2||yy>y+rh-3)samples.push(at(xx,yy));}
 const counts=new Map();for(const p of samples){const k=p.map(n=>n>>2).join(',');counts.set(k,(counts.get(k)||0)+1);}
 const key=[...counts].sort((a,b)=>b[1]-a[1])[0]?.[0];const cluster=samples.filter(p=>p.map(n=>n>>2).join(',')===key);
 const bg=[0,1,2].map(k=>median((cluster.length?cluster:samples).map(p=>p[k])));
 const ink=[];for(let yy=Math.max(0,y);yy<Math.min(h,y+rh);yy+=2)for(let xx=Math.max(0,x);xx<Math.min(w,x+rw);xx+=2){const p=at(xx,yy);if(Math.max(...p.map((n,k)=>Math.abs(n-bg[k])))>45)ink.push(p);}
 ink.sort((a,b)=>a.reduce((s,n,k)=>s+Math.abs(n-bg[k]),0)-b.reduce((s,n,k)=>s+Math.abs(n-bg[k]),0));
 const tail=ink.slice(Math.floor(ink.length*.8));const fg=tail.length?[0,1,2].map(k=>median(tail.map(p=>p[k]))):[17,17,17];
 return {background:hex(bg),color:hex(fg),backgroundUniformity:samples.length?cluster.length/samples.length:0};
}
export async function analyzeElements(reference,signal){
 const bytes=Buffer.from(reference.source.split(',')[1],'base64');const hash=createHash('sha256').update(bytes).digest('hex');
 if(cache.has(hash))return cache.get(hash);
 const {data,info}=await sharp(bytes).removeAlpha().raw().toBuffer({resolveWithObject:true});const {width:w,height:h,channels:c}=info;
 const lines=await readScreenshotText(bytes,signal);
 const executablePath=process.env.IMSTAGE_CHROMIUM_PATH||(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync));
 const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});let metrics;
 try{const page=await browser.newPage();metrics=await page.evaluate(({texts,font})=>{const ctx=document.createElement('canvas').getContext('2d');ctx.font=`400 100px ${font}`;return texts.map(t=>ctx.measureText(t).width);},{texts:lines.map(l=>l.text),font:FONT_STACK});}finally{await browser.close();}
 const elements=lines.map((line,i)=>{const pixels=pixelRect(line.box,w,h);const style=colors(data,w,h,c,pixels);const measured=pixels[2]/Math.max(1,metrics[i])*100;
 // OCR boxes include ascenders/descenders inconsistently. Width preserves source font size.
 const fontSize=Math.max(10,Math.min(160,Math.min(measured,pixels[3]*1.65)));
 return {id:`text-${i+1}`,kind:'text',text:line.text,confidence:line.confidence,box:line.box,pixels,characters:line.characters||[],style:{...style,fontSize:Math.round(fontSize*10)/10,fontWeight:400,align:'left'},coordinateSpace:'source_pixels'};});
 const out={sourceId:hash,width:w,height:h,coordinateSpace:'source_pixels',elements};cache.set(hash,out);if(cache.size>8)cache.delete(cache.keys().next().value);return out;
}
const union=rs=>{const x=Math.min(...rs.map(r=>r[0])),y=Math.min(...rs.map(r=>r[1]));return [x,y,Math.max(...rs.map(r=>r[0]+r[2]))-x,Math.max(...rs.map(r=>r[1]+r[3]))-y];};
export async function textEdits(reference,{elementIds,search,text,id},signal){
 if(typeof text!=='string'||!text.trim())throw new Error('替换文字不能为空');
 const doc=await analyzeElements(reference,signal);let nodes=doc.elements.filter(e=>elementIds?.includes(e.id));
 if(!elementIds?.length){if(typeof search!=='string'||!search)throw new Error('需要 elementIds 或精确 search');nodes=doc.elements.filter(e=>e.text.includes(search));}
 if(!nodes.length)throw new Error('源图中没有找到指定文字，请 read_elements 确认');
 if(elementIds?.some(id=>!nodes.some(n=>n.id===id)))throw new Error('文字元素不存在');
 const groups=search?nodes.flatMap(n=>{const matches=[];for(let at=n.text.indexOf(search);at>=0;at=n.text.indexOf(search,at+search.length))matches.push(at);if(n.characters.length!==Array.from(n.text).length)matches.splice(1);return matches.map((at,i)=>Object.assign([n],{matchAt:at,matchIndex:matches.length>1?i+1:null}));}):elementIds?.length>1?[nodes]:nodes.map(n=>[n]);
 const bytes=Buffer.from(reference.source.split(',')[1],'base64');
 const {data,info}=await sharp(bytes).removeAlpha().raw().toBuffer({resolveWithObject:true});
 return groups.map((group,index)=>{
 const first=group[0];let rect=union(group.map(n=>n.pixels));let replacement=text;let fontSize=first.style.fontSize;
 if(search){if(!first.text.includes(search))throw new Error('所选元素不含 search');const chars=Array.from(first.text),start=Array.from(first.text.slice(0,group.matchAt)).length,len=Array.from(search).length;
 const range=first.characters.slice(start,start+len);
 if(range.length===len&&first.characters.length===chars.length){rect=union(range.map(ch=>pixelRect(ch.box,doc.width,doc.height)));
 if(/^[\p{Script=Han}]+$/u.test(search))fontSize=rect[2]/Array.from(search).length;}
 else replacement=first.text.replaceAll(search,text);
 }
 const pad=2;let x=Math.max(0,Math.floor(rect[0]-pad)),y=Math.max(0,Math.floor(rect[1]-pad));
 let width=Math.min(doc.width-x,Math.ceil(rect[2]+pad*2)),height=Math.min(doc.height-y,Math.ceil(rect[3]+pad*2));
 const eraseBox=normalizeRect([x,y,width,height],doc.width,doc.height);
 const sourceCentered=Math.abs(rect[0]+rect[2]/2-doc.width/2)<doc.width*.025 && (reference.plan.im==='wechat'||rect[1]>doc.height*.2);
 const neededHeight=Math.ceil(fontSize*1.12);if(height<neededHeight){y=Math.max(0,Math.floor(y-(neededHeight-height)/2));height=Math.min(doc.height-y,neededHeight);}
 // Expand only across measured flat background, bounded by other OCR elements.
 // A longer replacement uses existing empty content space, never paints over labels.
 const units=t=>Array.from(t).reduce((n,ch)=>n+(/[\p{Script=Han}]/u.test(ch)?1:/[ilI.,'! ]/.test(ch)?.28:.55),0);
 const neededWidth=Math.ceil(units(replacement)*fontSize+6);
 if(neededWidth>width && (!search||search===first.text)){
  const bg=first.style.background.match(/[a-f0-9]{2}/gi).map(n=>parseInt(n,16));
  const sampleY=Math.max(0,Math.floor(rect[1]-5));let limit=x+width;
  for(let px=Math.min(doc.width-1,Math.ceil(rect[0]+rect[2]));px<doc.width-4;px++){
   const i=(sampleY*doc.width+px)*info.channels;if(bg.some((n,k)=>Math.abs(data[i+k]-n)>6))break;limit=px-5;
  }
  for(const other of doc.elements){if(group.includes(other))continue;const [ox,oy,ow,oh]=other.pixels;if(oy<y+height&&oy+oh>y&&ox>x+width)limit=Math.min(limit,ox-5);}
  width=Math.max(width,Math.min(neededWidth,limit-x));
  if(neededWidth>width){
   let topLimit=Math.max(0,y-fontSize*.65),bottomLimit=Math.min(doc.height,y+height+fontSize*.8);
   for(const other of doc.elements){if(group.includes(other))continue;const [ox,oy,ow,oh]=other.pixels;if(ox<x+width&&ox+ow>x){if(oy>y)bottomLimit=Math.min(bottomLimit,oy-8);if(oy+oh<y+height)topLimit=Math.max(topLimit,oy+oh+8);}}
   const safe=(yy)=>{for(let xx=x;xx<x+width;xx+=5){const i=(Math.floor(yy)*doc.width+Math.floor(xx))*info.channels;if(bg.some((n,k)=>Math.abs(data[i+k]-n)>6))return false;}return true;};
   while(y>topLimit&&safe(y-1)) {y--;height++;}
   while(y+height<bottomLimit&&safe(y+height))height++;
  }
 }
 if(sourceCentered&&!search){x=Math.max(0,(doc.width-width)/2);}
 return {eraseBox,id:id?`${id}${groups.length>1?'-'+(index+1):''}`:`semantic-${first.id}${group.matchIndex?"-match-"+group.matchIndex:""}`,kind:'text',backgroundMode:'source',text:replacement,box:normalizeRect([x,y,width,height],doc.width,doc.height),background:first.style.background,color:first.style.color,fontSize,fontWeight:first.style.fontWeight,align:sourceCentered&&!search?'center':'left',minFontSize:fontSize*.94,lineHeight:1.12};
 });
}
