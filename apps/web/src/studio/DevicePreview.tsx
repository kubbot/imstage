import {useEffect,useRef,useState,type ReactNode} from 'react';
import {deviceProfile} from './device-profiles';
import type {Scene} from './model';
/** Fit the coded viewport without changing its layout or the exported pixels. */
export default function DevicePreview({scene,full,children}:{scene:Scene;full:boolean;children:ReactNode}) {
  const host=useRef<HTMLDivElement>(null);const [available,setAvailable]=useState(420);
  useEffect(()=>{const el=host.current;if(!el)return;const observer=new ResizeObserver(entries=>setAvailable(entries[0].contentRect.width));observer.observe(el);return()=>observer.disconnect();},[]);
  const profile=deviceProfile(scene);const width=scene.reference?Math.min(393,scene.reference.plan.width):profile.width;
  return <div className="device-preview" ref={host}><div className="agent-phone device-frame" data-mode={full?'full':'standard'} data-surface={scene.surface||'ios'} style={{width:width+16,height:scene.reference||full?'auto':profile.height+16,zoom:Math.min(1,Math.max(.1,(available-4)/(width+16)))}}>{children}</div></div>;
}
