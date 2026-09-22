import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// OCR consumes source pixels only. Never receives expected edits or task answers.
export async function readScreenshotText(bytes,signal) {
  const mac=process.platform==='darwin';
  const command=mac?'swift':'tesseract';
  const args=mac?[fileURLToPath(new URL('../../tools/ocr/vision.swift',import.meta.url))]:['stdin','stdout','-l','eng+chi_sim+rus','tsv'];
  const output=await new Promise((resolve,reject)=>{
    const p=spawn(command,args,{stdio:['pipe','pipe','pipe'],signal});let chunks=[];let size=0;
    const timer=setTimeout(()=>p.kill(),25000);
    p.stdin.on('error',()=>{});p.stdin.end(bytes);p.stderr.resume();
    p.stdout.on('data',d=>{size+=d.length;if(size>1024*1024)p.kill();else chunks.push(d);});
    p.on('error',e=>{clearTimeout(timer);reject(new Error(e.name==='AbortError'?'已取消':'OCR 工具不可用，请安装系统 OCR 依赖'));});
    p.on('close',code=>{clearTimeout(timer);code===0?resolve(Buffer.concat(chunks).toString()):reject(new Error('OCR 未完成'));});
  });
  if(mac)return JSON.parse(output);
  const lines=output.trim().split('\n');const records=lines.slice(1).map(l=>l.split('\t'));const page=records.find(r=>r[0]==='1');const w=Number(page?.[8]),h=Number(page?.[9]);
  if(!w||!h)throw new Error('OCR 没有读取到图像尺寸');
  return records.filter(r=>r[0]==='5'&&r[11]?.trim()).map(r=>({text:r.slice(11).join('\t'),confidence:Number(r[10])/100,box:[Number(r[6])/w*1000,Number(r[7])/h*1000,Number(r[8])/w*1000,Number(r[9])/h*1000]}));
}
