import { useEffect, useRef, useState } from 'react';
const limit=()=>Math.max(360,Math.min(640,Math.floor(window.innerWidth*.48)));
export function useCreationWidth(){
  const [width,setWidth]=useState(()=>{try{const value=Number(localStorage.getItem('imstage.creation-width'));return Math.min(limit(),value>=360&&value<=640?value:480);}catch{return Math.min(limit(),480);}});
  useEffect(()=>{const resize=()=>setWidth(w=>Math.max(360,Math.min(limit(),w)));window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
  useEffect(()=>{const timer=setTimeout(()=>{try{localStorage.setItem('imstage.creation-width',String(width));}catch{}},250);return()=>clearTimeout(timer);},[width]);
  return [width,(next:number)=>setWidth(Math.max(360,Math.min(limit(),next)))] as const;
}
export default function CreationDivider({width,onChange}:{width:number;onChange:(value:number)=>void}){
  const drag=useRef<{id:number;x:number;width:number}|null>(null);
  const [moving,setMoving]=useState(false);
  return <div className="creation-divider" role="separator" aria-controls="creation-panel" title="拖动调整创作区宽度，双击恢复" aria-label="调整创作区宽度" aria-orientation="vertical" aria-valuemin={360} aria-valuemax={limit()} aria-valuenow={width} aria-valuetext={`${width} 像素`} tabIndex={0} data-moving={moving}
    onDoubleClick={()=>onChange(480)}
    onKeyDown={e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();onChange(e.key==='Home'?360:e.key==='End'?limit():width+(e.key==='ArrowLeft'?-24:24));}}}
    onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);drag.current={id:e.pointerId,x:e.clientX,width:e.currentTarget.previousElementSibling?.getBoundingClientRect().width||width};setMoving(true);}}
    onPointerMove={e=>{const start=drag.current;if(start?.id===e.pointerId)onChange(start.width+e.clientX-start.x);}}
    onPointerUp={e=>{if(drag.current?.id!==e.pointerId)return;drag.current=null;setMoving(false);e.currentTarget.releasePointerCapture(e.pointerId);}}
    onPointerCancel={()=>{drag.current=null;setMoving(false);}} onLostPointerCapture={()=>{drag.current=null;setMoving(false);}}><span/></div>;
}
