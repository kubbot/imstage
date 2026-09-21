import test from 'node:test';import assert from 'node:assert/strict';import sharp from 'sharp';
import {referenceScene,renderReference} from '../services/agent/screenshot-tools.mjs';
// Two opposite-polarity glyph-like marks; both must disappear from the erase
// region while the new text is laid out elsewhere and protected pixels stay.
test('source restoration erases dark and light marks and preserves outside pixels',async()=>{
 const svg=Buffer.from('<svg width="300" height="180"><rect width="300" height="90" fill="#eeeeee"/><rect y="90" width="300" height="90" fill="#164530"/><rect x="30" y="25" width="20" height="35" fill="black"/><rect x="60" y="25" width="20" height="35" fill="#e7e7e7"/><rect x="30" y="115" width="20" height="35" fill="white"/></svg>');
 const source=await sharp(svg).png().toBuffer();const scene=referenceScene({im:'wechat',surface:'ios',width:300,height:180,source:{mime:'image/png',dataBase64:source.toString('base64')}});
 scene.reference.plan.edits=[0,1].map(i=>({id:'text-'+i,kind:'text',text:'NEW',box:[400,50+i*500,300,350],eraseBox:[80,100+i*500,220,270],background:i?'#164530':'#eeeeee',color:i?'#ffffff':'#000000',fontSize:24,fontWeight:400,align:'left',backgroundMode:'source'}));
 const out=await renderReference(scene.reference);const {data,info}=await sharp(out.buffer).removeAlpha().raw().toBuffer({resolveWithObject:true});
 const pixel=(x,y)=>Array.from(data.subarray((y*info.width+x)*3,(y*info.width+x)*3+3));
 assert.deepEqual(pixel(40,40),[238,238,238]);assert.deepEqual(pixel(70,40),[238,238,238]);assert.deepEqual(pixel(40,130),[22,69,48]);assert.deepEqual(pixel(290,170),[22,69,48]);assert.ok(out.textFits.every(t=>t.fits));
});

test('text erasure touching the image edge never samples the old glyph',async()=>{
 const source=await sharp(Buffer.from('<svg width="240" height="200"><rect width="240" height="200" fill="#eeeeee"/><rect x="20" width="30" height="25" fill="black"/><rect x="20" y="175" width="30" height="25" fill="black"/></svg>')).png().toBuffer();
 const scene=referenceScene({im:'wechat',surface:'ios',width:240,height:200,source:{mime:'image/png',dataBase64:source.toString('base64')}});
 scene.reference.plan.edits=[0,1].map(i=>({id:'edge-'+i,kind:'text',text:'NEW',box:[500,100+i*600,400,200],eraseBox:[50,i*800,200,200],background:'#eeeeee',color:'#111111',fontSize:20,backgroundMode:'source'}));
 const out=await renderReference(scene.reference);const {data,info}=await sharp(out.buffer).removeAlpha().raw().toBuffer({resolveWithObject:true});
 for(const y of [0,12,188,199])assert.deepEqual(Array.from(data.subarray((y*info.width+30)*3,(y*info.width+30)*3+3)),[238,238,238]);
});

test('message text flows around protected receipt pixels and erases the whole old body',async()=>{
 const source=await sharp(Buffer.from('<svg width="400" height="240"><rect width="400" height="240" fill="#d9fdd3"/><rect x="40" y="125" width="20" height="20" fill="black"/><rect x="270" y="120" width="90" height="40" fill="#ef2345"/></svg>')).png().toBuffer();
 const scene=referenceScene({im:'whatsapp',surface:'ios',width:400,height:240,source:{mime:'image/png',dataBase64:source.toString('base64')}});
 const norm=([x,y,w,h])=>[x/400*1000,y/240*1000,w/400*1000,h/240*1000];
 scene.reference.plan.edits=[{id:'body',kind:'text',text:'A longer message wraps into the space left of the original receipt.',box:norm([30,40,340,130]),metadataBox:norm([260,110,110,60]),background:'#d9fdd3',color:'#111111',fontSize:26,minFontSize:20,fontWeight:400,align:'left',backgroundMode:'solid',lineHeight:1.12}];
 const out=await renderReference(scene.reference);assert.ok(out.textFits.every(t=>t.fits));
 const old=await sharp(source).removeAlpha().extract({left:260,top:110,width:110,height:60}).raw().toBuffer();const kept=await sharp(out.buffer).removeAlpha().extract({left:260,top:110,width:110,height:60}).raw().toBuffer();assert.deepEqual(kept,old);
});

test('receipt protection never expands the explicitly requested erase region',async()=>{
 const source=await sharp(Buffer.from('<svg width="400" height="200"><rect width="400" height="200" fill="#eeeeee"/><rect x="280" y="30" width="50" height="30" fill="#22cc44"/><rect x="310" y="155" width="60" height="25" fill="#111111"/></svg>')).png().toBuffer();
 const scene=referenceScene({im:'whatsapp',surface:'ios',width:400,height:200,source:{mime:'image/png',dataBase64:source.toString('base64')}});
 scene.reference.plan.edits=[{id:'body',kind:'text',text:'Hi',box:[0,0,1000,1000],eraseBox:[0,0,500,500],metadataBox:[750,750,250,250],background:'#eeeeee',color:'#111111',fontSize:20,backgroundMode:'solid'}];
 const out=await renderReference(scene.reference);const {data}=await sharp(out.buffer).removeAlpha().raw().toBuffer({resolveWithObject:true});
 for(const [x,y,color] of [[300,40,[34,204,68]],[320,160,[17,17,17]]])assert.deepEqual(Array.from(data.subarray((y*400+x)*3,(y*400+x)*3+3)),color);
});
