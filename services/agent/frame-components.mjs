// Connected foreground components on a locally uniform chat wallpaper.
// This rejects low-confidence textured wallpapers instead of inventing a frame.
export function componentFrame(data,w,h,c,initial){
 const [x1,y1,x2,y2]=initial;const ring=[];const colors=new Map();
 for(let y=Math.max(0,Math.round(y1)-25);y<Math.min(h,y2+25);y+=3)for(let x=Math.max(0,Math.round(x1)-25);x<Math.min(w,x2+25);x+=3){if(x>x1+8&&x<x2-8&&y>y1+8&&y<y2-8)continue;const i=(y*w+x)*c,k=[data[i]>>2,data[i+1]>>2,data[i+2]>>2].join(',');ring.push(k);colors.set(k,(colors.get(k)||0)+1);}
 const [key,count]=[...colors].sort((a,b)=>b[1]-a[1])[0]||[];if(!key||count/ring.length<.32)return null;
 const bg=key.split(',').map(n=>Number(n)*4+2);const left=Math.max(0,Math.floor(x1)-100),top=Math.max(0,Math.floor(y1)-100),right=Math.min(w,Math.ceil(x2)+100),bottom=Math.min(h,Math.ceil(y2)+100);const rw=right-left,rh=bottom-top;
 const mask=new Uint8Array(rw*rh);for(let y=0;y<rh;y++)for(let x=0;x<rw;x++){const i=((y+top)*w+x+left)*c;mask[y*rw+x]=Math.max(...bg.map((n,k)=>Math.abs(n-data[i+k])))>11?1:0;}
 const queue=new Int32Array(mask.length);let best=null;
 for(let i=0;i<mask.length;i++){if(mask[i]!==1)continue;let start=0,end=1,n=0,minX=rw,minY=rh,maxX=0,maxY=0;queue[0]=i;mask[i]=2;
 while(start<end){const q=queue[start++],x=q%rw,y=Math.floor(q/rw);n++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
 for(const next of [x>0?q-1:-1,x<rw-1?q+1:-1,y>0?q-rw:-1,y<rh-1?q+rw:-1])if(next>=0&&mask[next]===1){mask[next]=2;queue[end++]=next;}}
 const rect=[minX+left,minY+top,maxX-minX+1,maxY-minY+1];if(n<400||rect[2]<20||rect[3]<20)continue;
 const inter=Math.max(0,Math.min(x2,rect[0]+rect[2])-Math.max(x1,rect[0]))*Math.max(0,Math.min(y2,rect[1]+rect[3])-Math.max(y1,rect[1]));const iou=inter/((x2-x1)*(y2-y1)+rect[2]*rect[3]-inter);
 const density=n/(rect[2]*rect[3]);if(iou>.6&&density>.75&&(!best||iou>best.confidence))best={pixels:rect,confidence:iou,method:'source_connected_component',density};
 }
 return best;
}

/** Snap a detected boundary to the strongest adjacent-pixel transition.
 * Component masks include JPEG ringing; the transition separates content from
 * that ringing. Search stays local so interior details cannot move the frame.
 */
export function refineRectEdges(data,w,h,c,pixels){
 const [x,y,rw,rh]=pixels;
 const edge=(position,axis,start,end)=>{
  let best=Math.round(position),strength=0;
  const margin=(end-start)*.22;
  for(let p=Math.max(1,Math.round(position)-4);p<=Math.min((axis==='x'?w:h)-1,Math.round(position)+4);p++){
   let total=0,n=0;
   for(let k=Math.ceil(start+margin);k<end-margin;k+=2){
    const a=axis==='x'?(k*w+p-1)*c:((p-1)*w+k)*c;
    const b=axis==='x'?(k*w+p)*c:(p*w+k)*c;
    total+=(Math.abs(data[a]-data[b])+Math.abs(data[a+1]-data[b+1])+Math.abs(data[a+2]-data[b+2]))/3;n++;
   }
   const score=total/Math.max(n,1);if(score>strength){strength=score;best=p;}
  }
  return strength>=12?best:Math.round(position);
 };
 const l=edge(x,'x',y,y+rh),r=edge(x+rw,'x',y,y+rh),t=edge(y,'y',x,x+rw),b=edge(y+rh,'y',x,x+rw);
 return r>l&&b>t?[l,t,r-l,b-t]:pixels;
}

/** Enumerate large, isolated content cards on a flat chat background. The
 * caller chooses a region by ID; the model never has to transcribe its box.
 * These are geometric candidates, not claims that OCR has identified a photo.
 */
export function contentRegions(data,w,h,c,{minWidth=.22,minHeight=.055}={}){
 const counts=new Map();
 for(let y=Math.round(h*.12);y<h*.89;y+=5)for(let x=0;x<w;x+=5){const i=(y*w+x)*c;const key=[data[i]>>2,data[i+1]>>2,data[i+2]>>2].join(',');counts.set(key,(counts.get(key)||0)+1);}
 const [key,n]=[...counts].sort((a,b)=>b[1]-a[1])[0]||[];
 if(!key||n/[...counts.values()].reduce((a,b)=>a+b,0)<.2)return [];
 const bg=key.split(',').map(v=>Number(v)*4+2),mask=new Uint8Array(w*h),queue=new Int32Array(w*h),result=[];
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*c;mask[y*w+x]=Math.max(...bg.map((n,k)=>Math.abs(n-data[i+k])))>11?1:0;}
 for(let i=0;i<mask.length;i++){
  if(mask[i]!==1)continue;let start=0,end=1,count=0,l=w,t=h,r=0,b=0;queue[0]=i;mask[i]=2;
  while(start<end){const q=queue[start++],x=q%w,y=Math.floor(q/w);count++;l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);
   for(const p of [x>0?q-1:-1,x<w-1?q+1:-1,y>0?q-w:-1,y<h-1?q+w:-1])if(p>=0&&mask[p]===1){mask[p]=2;queue[end++]=p;}
  }
  const rw=r-l+1,rh=b-t+1;
  if(l===0||r===w-1||t<h*.12||b>h*.90||rw<w*minWidth||rh<h*minHeight||count/(rw*rh)<.8)continue;
  result.push({pixels:refineRectEdges(data,w,h,c,[l,t,rw,rh]),method:'source_content_component',confidence:count/(rw*rh)});
 }
 return result.sort((a,b)=>a.pixels[1]-b.pixels[1]);
}
