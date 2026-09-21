import { fitDocumentText } from '../../../../packages/renderer/fitText.mjs';
import { buildEditPlanHtml } from '../../../../packages/renderer/editPlanHtml.mjs';
import type { ReferenceDocument } from '../../../../packages/schema/reference';
/** The exact benchmark HTML is embedded at original source resolution. */
export default function ReferenceView({document:doc,onSelect}:{document:ReferenceDocument;onSelect?:(id:string)=>void}) {
  const html=buildEditPlanHtml(doc.plan,{width:doc.plan.width,height:doc.plan.height,sourceDataUri:doc.source,assetDataUris:new Map(doc.assets.map(a=>[a.id,a.dataUrl]))});
  const script=`<script>document.fonts.ready.then(${fitDocumentText.toString()});</script>`;
  const scale=360/doc.plan.width;
  return <div className="reference-preview" style={{width:360,height:doc.plan.height*scale,position:'relative'}}>
    <iframe title="原截图精确编辑画面" sandbox="allow-scripts" srcDoc={html.replace('</body>',`${script}</body>`)} style={{border:0,width:doc.plan.width,height:doc.plan.height,transform:`scale(${scale})`,transformOrigin:'top left',position:'absolute',pointerEvents:'none'}}/>
    {onSelect&&doc.plan.edits.map(edit=><button key={edit.id} type="button" className="reference-select" aria-label={`选择编辑层：${edit.text||edit.assetId||edit.id}`} onClick={()=>onSelect(edit.id)} style={{position:'absolute',left:edit.box[0]*360/1000,top:edit.box[1]*doc.plan.height*scale/1000,width:edit.box[2]*360/1000,height:edit.box[3]*doc.plan.height*scale/1000}}/>)}
  </div>;
}
