import sharp from 'sharp';
import { validateBox } from '../../packages/schema/edit-plan.mjs';
// Refine an approximate rectangular photo frame using only source-pixel edges.
// This tool never knows the benchmark's expected rectangles.
export async function findFrame(source,box) {
 validateBox(box,'box');const {data,info}=await sharp(source,{limitInputPixels:8_000_000}).removeAlpha().raw().toBuffer({resolveWithObject:true});
 const {width:w,height:h,channels:c}=info;const initial=[box[0]*w/1000,box[1]*h/1000,(box[0]+box[2])*w/1000,(box[1]+box[3])*h/1000];
 // Most frequent quantized color is the nearby chat wallpaper, not a gold hint.
 const counts=new Map();const cx=(initial[0]+initial[2])/2,cy=(initial[1]+initial[3])/2;
 for(let y=Math.max(0,Math.floor(initial[1]-80));y<Math.min(h,initial[3]+80);y+=3)for(let x=Math.max(0,Math.floor(initial[0]-80));x<Math.min(w,initial[2]+80);x+=3){const i=(y*w+x)*c;const key=[data[i]>>3,data[i+1]>>3,data[i+2]>>3].join(',');counts.set(key,(counts.get(key)||0)+1);}
 const dominant=[...counts].sort((a,b)=>b[1]-a[1])[0][0].split(',').map(n=>Number(n)*8+4);
 const distance=(i)=>Math.max(...dominant.map((n,k)=>Math.abs(n-data[i+k])));
 const score=(axis,at,start,end,side)=>{let total=0,n=0;for(let k=Math.ceil(start);k<end;k+=2){const x=axis===0?at:k,y=axis===0?k:at;if(x<6||x>=w-6||y<6||y>=h-6)continue;
 const outside=((axis===0?y:y+side*4)*w+(axis===0?x+side*4:x))*c,inside=((axis===0?y:y-side*4)*w+(axis===0?x-side*4:x))*c;
 const near=(y*w+x)*c;
 const bg=distance(outside)<12,fg=distance(inside)>13;
 let delta=0;for(let ch=0;ch<3;ch++)delta+=Math.abs(data[outside+ch]-data[inside+ch]);
 total+=(bg&&fg?150:0)+Math.min(delta,180)*.08+(distance(near)<8&&fg?12:0);n++;}return n?total/n:0;};
 const edge=(value,axis,a,b,side)=>{const margin=(b-a)*.28;let best=Math.round(value),quality=-1;const max=axis===0?w:h;for(let pos=Math.max(6,Math.round(value)-90);pos<Math.min(max-6,Math.round(value)+91);pos++){if(axis===0&&(side<0?pos>=cx-12:pos<=cx+12)||axis===1&&(side<0?pos>=cy-12:pos<=cy+12))continue;const v=score(axis,pos,a+margin,b-margin,side)-Math.abs(pos-value)*.07;if(v>quality){quality=v;best=pos;}}return {value:best,quality};};
 const l=edge(initial[0],0,initial[1],initial[3],-1),r=edge(initial[2],0,initial[1],initial[3],1);const t=edge(initial[1],1,l.value,r.value,-1),b=edge(initial[3],1,l.value,r.value,1);
 const found=[l.value/w*1000,t.value/h*1000,(r.value-l.value)/w*1000,(b.value-t.value)/h*1000];validateBox(found,'frame');
 return {box:found,pixels:[l.value,t.value,r.value-l.value,b.value-t.value],edgeStrength:[l,t,r,b].map(x=>Number(x.quality.toFixed(2))),note:'基于像素边缘测量，请对照原图确认；圆角不改变外接矩形。'};
}
