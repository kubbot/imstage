import { validatePlan } from './edit-plan.mjs';
export interface ReferenceEdit { id:string; kind:'text'|'image';box:number[];text?:string;assetId?:string;background:string;color:string;fontSize:number;fontWeight:number;align:string;radius:number;fit:string; }
export interface ReferenceDocument { source:string; plan:{schemaVersion:1;im:string;surface:string;width:number;height:number;edits:ReferenceEdit[];warnings:string[]};assets:{id:string;dataUrl:string;description:string}[]; }
const image=(v:unknown):v is string=>typeof v==='string'&&v.length<=6*1024*1024&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(v);
export function validateReference(raw:unknown):ReferenceDocument {
  if(!raw || typeof raw!=='object')throw new Error('截图编辑文档无效');
  const r=raw as ReferenceDocument;
  if(!image(r.source)||!Array.isArray(r.assets)||r.assets.length>32)throw new Error('截图或素材无效');
  const seen=new Set();const assets=r.assets.map(a=>{if(!a||!image(a.dataUrl)||!/^[-\w]{1,128}$/.test(a.id)||seen.has(a.id)||typeof a.description!=='string'||a.description.length>1200)throw new Error('截图素材无效');seen.add(a.id);return {id:a.id,dataUrl:a.dataUrl,description:a.description};});
  const {plan}=validatePlan(r.plan,{mode:"model",authorizedAssetIds:assets.map(a=>a.id)});
  return {source:r.source,assets,plan:plan as ReferenceDocument['plan']};
}
