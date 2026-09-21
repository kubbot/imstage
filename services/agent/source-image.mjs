import sharp from 'sharp';
import {isBoundedImageDataUrl,detectImageMime} from './media.mjs';
import {findAvatarSlots} from './image-slots.mjs';

/** Crop only a supplied attachment; coordinates refer to its upright displayed image. */
export async function cropAttachment(attachments, index, box, signal, maxChars=6*1024*1024, {avatar=false}={}) {
 signal?.throwIfAborted();
 if(!Number.isInteger(index)||index<0||index>=attachments.length)throw new Error('attachmentIndex 必须指向本次上传图片（从 0 开始）');
 if(!Array.isArray(box)||box.length!==4||!box.every(Number.isFinite))throw new Error('box 必须是 [x,y,width,height]，归一化到 0..1000');
 const [x,y,w,h]=box;
 if(x<0||y<0||w<=0||h<=0||x+w>1000||y+h>1000)throw new Error('裁切区域必须完整位于原图内');
 const source=attachments[index];if(!isBoundedImageDataUrl(source,maxChars))throw new Error('截图附件无效或超出限制');
 const bytes=Buffer.from(source.split(',')[1],'base64');
 if(!detectImageMime(bytes))throw new Error('截图必须是可解码的 PNG、JPEG 或 WebP');
 const {data,info}=await sharp(bytes,{limitInputPixels:40_000_000}).rotate().raw().toBuffer({resolveWithObject:true});
 signal?.throwIfAborted();
 let left=Math.round(x*info.width/1000),top=Math.round(y*info.height/1000);
 let width=Math.round((x+w)*info.width/1000)-left,height=Math.round((y+h)*info.height/1000)-top;
 if(width<2||height<2)throw new Error('裁切区域太小，请重新定位原图');
 let method='requested_box';
 if(avatar){
  // Work in upright source pixels so EXIF rotation and normalized coordinates agree.
  const upright=await sharp(data,{raw:info}).png().toBuffer();
  const slots=await findAvatarSlots({source:'data:image/png;base64,'+upright.toString('base64'),plan:{im:'wechat'}},signal);
  signal?.throwIfAborted();
  const matches=slots.filter(({pixels:[sx,sy,sw,sh]})=>{
   const area=Math.max(0,Math.min(left+width,sx+sw)-Math.max(left,sx))*Math.max(0,Math.min(top+height,sy+sh)-Math.max(top,sy));
   return area/Math.min(width*height,sw*sh)>=.5;
  });
  if(matches.length===1){[left,top,width,height]=matches[0].pixels;method='source_avatar_component';}
  else if(matches.length>1)throw new Error('区域包含多个头像，请选择其中一处：'+JSON.stringify(matches.map(s=>({side:s.side,box:s.box}))));
  else if(slots.length)throw new Error('区域未匹配完整头像，请根据人物位置选择检测到的头像区域：'+JSON.stringify(slots.slice(0,12).map(s=>({side:s.side,box:s.box}))));
  if(Math.abs(width/height-1)>.12)throw new Error(`头像裁切应包含完整近正方形区域，当前像素为 ${width}×${height}。归一化宽、高分别按原图宽、高换算；请重新定位边界。`);
 }
 const cropped=await sharp(data,{raw:info}).extract({left,top,width,height}).png().toBuffer();
 signal?.throwIfAborted();
 const dataUrl='data:image/png;base64,'+cropped.toString('base64');
 if(!isBoundedImageDataUrl(dataUrl,maxChars))throw new Error('裁切图片超出大小限制');
 return {dataUrl,pixels:[left,top,width,height],box:[left/info.width*1000,top/info.height*1000,width/info.width*1000,height/info.height*1000],method};
}
