import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {findFrame} from './frame.mjs';
import {refineRectEdges,contentRegions} from './frame-components.mjs';
import {analyzeElements,normalizeRect,pixelRect} from './elements.mjs';
import {validateBox} from '../../packages/schema/edit-plan.mjs';
const frames=new Map();
const sourceKey=r=>createHash('sha256').update(r.source).digest('hex').slice(0,16);
export function rememberFrame(reference,frame){const frameId='frame-'+createHash('sha256').update(JSON.stringify([sourceKey(reference),frame.box])).digest('hex').slice(0,16);frames.set(frameId,{...frame,sourceKey:sourceKey(reference)});if(frames.size>500)frames.delete(frames.keys().next().value);return {...frame,frameId};}
export function resolveFrame(reference,frameId){const f=frames.get(frameId);if(!f||f.sourceKey!==sourceKey(reference))throw new Error('槽位不存在或不属于当前源图，请重新 find_frame');return f;}
export async function measureFrame(reference,box){return rememberFrame(reference,await findFrame(Buffer.from(reference.source.split(',')[1],'base64'),box));}
export async function listContentFrames(reference){
 const {data,info}=await sharp(Buffer.from(reference.source.split(',')[1],'base64')).removeAlpha().raw().toBuffer({resolveWithObject:true});
 return contentRegions(data,info.width,info.height,info.channels).map(f=>rememberFrame(reference,{...f,kind:'content_region',box:normalizeRect(f.pixels,info.width,info.height),coordinateSpace:'normalized_1000'}));
}
/** WeChat side-avatar slots measured from source pixels, not task/answer metadata. */
export async function findAvatarSlots(reference,signal){
 if(reference.plan?.im==='whatsapp')return findContactAvatars(reference,signal);
 const {data,info}=await sharp(Buffer.from(reference.source.split(',')[1],'base64')).removeAlpha().raw().toBuffer({resolveWithObject:true});const {width:w,height:h,channels:c}=info;const results=[];
 for(const [left,right] of [[0,Math.floor(w*.17)],[Math.floor(w*.83),w]]){
 const rw=right-left,counts=new Map();for(let y=0;y<h;y+=5)for(let x=left;x<right;x+=5){const i=(y*w+x)*c,k=[data[i]>>2,data[i+1]>>2,data[i+2]>>2].join(',');counts.set(k,(counts.get(k)||0)+1);}
 const bg=[...counts].sort((a,b)=>b[1]-a[1])[0][0].split(',').map(n=>Number(n)*4+2);const mask=new Uint8Array(rw*h);
 for(let y=0;y<h;y++)for(let x=0;x<rw;x++){const i=(y*w+x+left)*c;mask[y*rw+x]=Math.max(Math.abs(data[i]-bg[0]),Math.abs(data[i+1]-bg[1]),Math.abs(data[i+2]-bg[2]))>11?1:0;}
 const queue=new Int32Array(mask.length);
 for(let i=0;i<mask.length;i++){if(mask[i]!==1)continue;let start=0,end=1,n=0,minX=rw,minY=h,maxX=0,maxY=0;queue[0]=i;mask[i]=2;
 while(start<end){const q=queue[start++],x=q%rw,y=Math.floor(q/rw);n++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);for(const next of [x>0?q-1:-1,x<rw-1?q+1:-1,y>0?q-rw:-1,y<h-1?q+rw:-1])if(next>=0&&mask[next]===1){mask[next]=2;queue[end++]=next;}}
 const fw=maxX-minX+1,fh=maxY-minY+1;if(minX===0||maxX===rw-1||fw<w*.055||fw>w*.15||fh/fw<.85||fh/fw>1.15||n/(fw*fh)<.7)continue;
 const pixels=refineRectEdges(data,w,h,c,[left+minX,minY,fw,fh]);if(Math.abs(pixels[2]-pixels[3])<=4){const side=Math.max(pixels[2],pixels[3]);pixels[2]=side;pixels[3]=side;}const box=[pixels[0]/w*1000,pixels[1]/h*1000,pixels[2]/w*1000,pixels[3]/h*1000];results.push(rememberFrame(reference,{box,pixels,kind:'avatar',side:left===0?'left':'right',coordinateSpace:'normalized_1000',method:'source_avatar_component',confidence:.9}));
 }}
 return results.sort((a,b)=>a.pixels[1]-b.pixels[1]);
}

/** Measure a three-item left-tall album; separator and receipt footer stay outside slots. */
export async function measureAlbum(reference,box){
 validateBox(box,'box');
 const {data,info}=await sharp(Buffer.from(reference.source.split(',')[1],'base64')).removeAlpha().raw().toBuffer({resolveWithObject:true});const w=info.width,h=info.height,c=info.channels;
 const rough=pixelRect(box,w,h);let [x,y,width,height]=rough.map(Math.round);let footer=-1;
 const greenAt=(xx,yy)=>{const i=(yy*w+xx)*c;return data[i]>150&&data[i+1]>data[i]+18&&data[i+1]>data[i+2]+18;};
 // Find the receipt strip first. Measuring the photo as a component can drop
 // this strip, which used to make a correct album crop impossible to resolve.
 for(let yy=Math.max(y,Math.floor(y+height*.6));yy<Math.min(h,y+height+100);yy++){
  let green=0,total=0;for(let xx=Math.ceil(x+width*.1);xx<Math.min(w,x+width*.85);xx+=3){total++;if(greenAt(xx,yy))green++;}
  if(total&&green/total>.88){footer=yy;break;}
 }
 if(footer<0)throw new Error('未识别到相册时间底栏，请传入包括时间的整个相册区域');
 while(footer>y){let green=0,total=0;for(let xx=Math.ceil(x+width*.1);xx<Math.min(w,x+width*.85);xx+=3){total++;if(greenAt(xx,footer-1))green++;}if(!total||green/total<=.88)break;footer--;}
 const scanY=Math.min(h-1,footer+5);let best=[0,0],start=-1;
 for(let xx=0;xx<w;xx++){
  if(greenAt(xx,scanY)){if(start<0)start=xx;}else if(start>=0){if(xx-start>best[1]-best[0])best=[start,xx];start=-1;}
 }
 if(start>=0&&w-start>best[1]-best[0])best=[start,w];
 if(best[1]-best[0]<width*.6)throw new Error('底栏左右边界不明确');
 x=best[0];width=best[1]-best[0];
 let top=y,topStrength=-1;
 for(let yy=Math.max(1,y-90);yy<Math.min(footer-30,y+90);yy++){
  let strength=0,total=0;for(let xx=Math.ceil(x+width*.1);xx<x+width*.9;xx+=3){const a=((yy-1)*w+xx)*c,b=(yy*w+xx)*c;strength+=(Math.abs(data[a]-data[b])+Math.abs(data[a+1]-data[b+1])+Math.abs(data[a+2]-data[b+2]))/3;total++;}
  const score=strength/Math.max(1,total);if(score>topStrength){topStrength=score;top=yy;}
 }
 y=top;height=footer-y+60;
 const brightness=(axis,pos,lo,hi)=>{let sum=0,n=0;for(let k=Math.ceil(lo);k<hi;k+=3){const xx=axis==='x'?pos:k,yy=axis==='y'?pos:k;const i=(yy*w+xx)*c;sum+=Math.min(data[i],data[i+1],data[i+2]);n++;}return sum/Math.max(1,n);};
 const strongest=(axis,center,range,lo,hi)=>{let best=center,score=-1;for(let p=Math.floor(center-range);p<=center+range;p++){const v=brightness(axis,p,lo,hi);if(v>score){score=v;best=p;}}return best;};
 const cx=strongest('x',x+width/2,width*.06,y+25,footer-25);
 const cy=strongest('y',y+(footer-y)/2,(footer-y)*.07,cx+20,x+width-20);
 const slots=[[x,y,cx-x-1,footer-y],[cx+2,y,x+width-cx-2,cy-y-1],[cx+2,cy+2,x+width-cx-2,footer-cy-2]];
 return {imageRole:'source',layout:'left-tall',footerPixels:[x,footer,width,y+height-footer],slots:slots.map((p,i)=>rememberFrame(reference,{kind:'album_slot',slot:i+1,corners:i===0?[width*.06,0,0,0]:i===1?[0,width*.06,0,0]:[0,0,0,0],pixels:p,box:[p[0]/w*1000,p[1]/h*1000,p[2]/w*1000,p[3]/h*1000],coordinateSpace:'normalized_1000',method:'source_album_separators',confidence:null}))};
}

// The iOS contact header uses a 40 pt avatar. OCR anchors the header;
// source edge measurements anchor the circle center. The profile card uses a
// larger measured circle rather than reusing the small header geometry.
async function findContactAvatars(reference,signal){
 const doc=await analyzeElements(reference,signal),scale=doc.width/390;
 const phones=doc.elements.filter(e=>/^\+\d[\d ()-]{7,}$/.test(e.text.trim()));const slots=[];
 for(const phone of phones){
  const header=phone.pixels[1]<doc.height*.2;
  const size=(header?40:88)*scale;
  const rough=header?[phone.pixels[0]-56*scale,phone.pixels[1]-16*scale,size,size]:[(doc.width-size)/2,phone.pixels[1]-104*scale,size,size];
  if(rough.some(n=>!Number.isFinite(n))||rough[0]<0||rough[1]<0)continue;
  const found=await findFrame(Buffer.from(reference.source.split(',')[1],'base64'),normalizeRect(rough,doc.width,doc.height));
  const side=header?Math.round(size):Math.max(found.pixels[2],found.pixels[3]);
  const cx=found.pixels[0]+found.pixels[2]/2,cy=found.pixels[1]+found.pixels[3]/2;
  const pixels=[Math.round(cx-side/2),Math.round(cy-side/2),side,side];
  slots.push(rememberFrame(reference,{kind:'avatar',role:header?'header':'profile',mask:'circle',pixels,box:normalizeRect(pixels,doc.width,doc.height),coordinateSpace:'normalized_1000',method:header?'whatsapp_ios_header_template':'source_profile_circle',confidence:null}));
 }
 return slots;
}

/** Split a color map from a white location-card header. Only source pixels
 * determine the split; title/address and the message tail remain protected.
 */
export async function measureCardImage(reference,frameId){
 const card=resolveFrame(reference,frameId),[x,y,width,height]=card.pixels;
 if(card.kind!=='content_region')throw new Error('需要list_content_frames返回的整张位置卡片槽位');
 const {data,info}=await sharp(Buffer.from(reference.source.split(',')[1],'base64')).removeAlpha().raw().toBuffer({resolveWithObject:true});const w=info.width,h=info.height,c=info.channels;
 const color=(xx,yy)=>Array.from(data.subarray((Math.floor(yy)*w+Math.floor(xx))*c,(Math.floor(yy)*w+Math.floor(xx))*c+3));
 let top=-1;
 for(let yy=y+Math.round(height*.1);yy<y+height*.65;yy++){
  let saturated=0,n=0;for(let xx=x+width*.08;xx<x+width*.85;xx+=3){const p=color(xx,yy);if(Math.max(...p)-Math.min(...p)>16)saturated++;n++;}
  if(n&&saturated/n>.35){top=yy;break;}
 }
 if(top<0)throw new Error('无法可靠区分白色卡片标题与彩色地图，请保持源图并报告未完成');
 const bg=color(Math.max(0,x-8),top+(y+height-top)/2);let l=x+width,r=x;
 for(let xx=x-3;xx<Math.min(w,x+width+3);xx++){
  let fg=0,n=0;for(let yy=top+8;yy<y+height-8;yy+=3){const p=color(xx,yy);if(p.some((v,k)=>Math.abs(v-bg[k])>11))fg++;n++;}
  if(n&&fg/n>.65){l=Math.min(l,xx);r=Math.max(r,xx);}
 }
 if(r-l<width*.8)throw new Error('地图左右边界不明确');
 const pixels=refineRectEdges(data,w,h,c,[l,top,r-l+1,y+height-top]);
 return rememberFrame(reference,{kind:'card_image',pixels,box:normalizeRect(pixels,w,h),corners:[0,0,8,8],coordinateSpace:'normalized_1000',method:'source_card_media_split',confidence:null});
}

/** Locate native WhatsApp bubble surfaces. Positive fill segmentation keeps
 * the patterned wallpaper out of the candidate even when global background
 * segmentation is ambiguous. OCR time labels are returned as protected data.
 */
export async function messageFrames(reference,signal){
 if(reference.plan.im!=='whatsapp')throw new Error('当前消息表面测量仅支持WhatsApp');
 const {data,info}=await sharp(Buffer.from(reference.source.split(',')[1],'base64')).removeAlpha().raw().toBuffer({resolveWithObject:true});const w=info.width,h=info.height,c=info.channels;
 const mask=new Uint8Array(w*h),queue=new Int32Array(w*h),result=[];const doc=await analyzeElements(reference,signal);
 for(let y=Math.floor(h*.14);y<h*.94;y++)for(let x=0;x<w;x++){const i=(y*w+x)*c,[r,g,b]=data.subarray(i,i+3);mask[y*w+x]=r>170&&g>r+12&&g>b+12?1:Math.min(r,g,b)>250?2:0;}
 for(let i=0;i<mask.length;i++){
  const fill=mask[i];if(!fill||fill>2)continue;let start=0,end=1,count=0,l=w,t=h,r=0,b=0;queue[0]=i;mask[i]=3;
  while(start<end){const q=queue[start++],x=q%w,y=Math.floor(q/w);count++;l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);
   for(const p of [x>0?q-1:-1,x<w-1?q+1:-1,y>0?q-w:-1,y<h-1?q+w:-1])if(p>=0&&mask[p]===fill){mask[p]=3;queue[end++]=p;}
  }
  const rw=r-l+1,rh=b-t+1;if(l===0||r===w-1||rw<w*.15||rh<h*.025||rh>h*.18||count/(rw*rh)<.65)continue;
  const nodes=doc.elements.filter(e=>e.pixels[0]>=l-3&&e.pixels[0]+e.pixels[2]<=r+3&&e.pixels[1]>=t-3&&e.pixels[1]+e.pixels[3]<=b+3);
  const times=nodes.filter(e=>/^\d{1,2}:\d{2}(?:[\s✓√vV/<>]+)?$/.test(e.text.trim()));if(!times.length)continue;
  const pixels=[l,t,rw,rh],padding=8*w/390,metaTop=Math.min(...times.map(e=>e.pixels[1]));
  const textPixels=[l+padding,t+4*w/390,rw-2*padding,rh-10*w/390];
  const timeLeft=Math.max(textPixels[0],Math.min(...times.map(e=>e.pixels[0]))-3*w/390),timeTop=Math.max(textPixels[1],metaTop-2*w/390);
  const metadataPixels=[timeLeft,timeTop,textPixels[0]+textPixels[2]-timeLeft,Math.max(1,textPixels[1]+textPixels[3]-timeTop)];
  if(textPixels[3]<14*w/390)continue;
  const mid=((t+3)*w+Math.round(l+rw/2))*c;const background='#'+Array.from(data.subarray(mid,mid+3)).map(n=>n.toString(16).padStart(2,'0')).join('');
  result.push(rememberFrame(reference,{kind:'message_text',pixels,box:normalizeRect(pixels,w,h),textPixels,metadataPixels,background,sourceTexts:nodes.filter(n=>!times.includes(n)).map(n=>n.text),protectedTimes:times.map(n=>n.text),coordinateSpace:'normalized_1000',method:'whatsapp_bubble_surface'}));
 }
 return result.sort((a,b)=>a.pixels[1]-b.pixels[1]).map((frame,i)=>({...frame,messageNumber:i+1,side:frame.pixels[0]>w*.3?'self':'other'}));
}
