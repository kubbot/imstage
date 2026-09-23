import { useEffect, useRef, useState, type ReactNode } from 'react';
import { deviceProfile } from './device-profiles';
import type { Scene } from './model';

/** Preview zoom never changes the renderer's native or exported dimensions. */
export default function DevicePreview({ scene, full, children, zoom = 'fit', onScale }: {
  scene: Scene; full: boolean; children: ReactNode; zoom?: 'fit' | number; onScale?: (scale: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(890);
  useEffect(() => {
    if (!frame.current) return;
    const observer = new ResizeObserver(([entry]) => setContentHeight(entry.borderBoxSize?.[0]?.blockSize || entry.contentRect.height + 16));
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  const [available, setAvailable] = useState({ width: 420, height: 680 });
  // Observe the independent viewport, not the zoomed content, to avoid feedback loops.
  // https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver
  // https://react.dev/reference/react/useEffect#connecting-to-an-external-system
  useEffect(() => {
    const viewport = host.current?.parentElement;
    if (!viewport) return;
    const observer = new ResizeObserver(([entry]) => setAvailable({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);
  const profile = deviceProfile(scene);
  const width = scene.reference ? 360 : profile.width;
  const height = scene.reference ? width * scene.reference.plan.height / scene.reference.plan.width : profile.height;
  const fit = Math.min(1, (available.width - 16) / (width + 16), full ? 1 : (available.height - 60) / (height + 16));
  const scale = typeof zoom === 'number' ? zoom : Math.max(.1, fit);
  useEffect(() => { onScale?.(scale); }, [scale, onScale]);
  return <div className="device-preview" ref={host} style={{ minWidth: (width + 16) * scale }}><div className="device-preview-stage" style={{width:(width+16)*scale,height:contentHeight*scale}}><div ref={frame} className="agent-phone device-frame" data-mode={full ? 'full' : 'standard'} data-surface={scene.surface || 'ios'} style={{ width: width + 16, height: scene.reference || full ? 'auto' : profile.height + 16, transform: `scale(${scale})`, transformOrigin:'top left' }}>{children}</div></div></div>;
}
