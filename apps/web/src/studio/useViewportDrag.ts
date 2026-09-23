import { useRef, type HTMLAttributes } from 'react';

/** Mouse dragging complements native touch/trackpad scrolling without stealing clicks. */
export function useViewportDrag(enabled: boolean): HTMLAttributes<HTMLDivElement> {
  const gesture = useRef<{id:number;y:number;top:number;scale:number;dragged:boolean} | null>(null);
  const suppressClick = useRef(false);
  if (!enabled) return {};
  return {
    onPointerDown(event) {
      suppressClick.current = false;
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      const el = event.currentTarget;
      if (el.scrollHeight <= el.clientHeight) return;
      gesture.current = {id:event.pointerId,y:event.clientY,top:el.scrollTop,scale:el.getBoundingClientRect().height / el.offsetHeight || 1,dragged:false};
    },
    onPointerMove(event) {
      const g=gesture.current;if(!g || g.id!==event.pointerId)return;
      if (!g.dragged && Math.abs(event.clientY-g.y)<5) return;
      g.dragged=true;suppressClick.current=true;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.dataset.dragging='true';
      event.currentTarget.scrollTop=g.top-(event.clientY-g.y)/g.scale;
      event.preventDefault();
    },
    onPointerLeave() {if(gesture.current && !gesture.current.dragged)gesture.current=null;},
    onPointerUp(event) {
      gesture.current=null;
      delete event.currentTarget.dataset.dragging;
      if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel(event) {gesture.current=null;delete event.currentTarget.dataset.dragging;},
    onLostPointerCapture(event) {gesture.current=null;delete event.currentTarget.dataset.dragging;},
    onClickCapture(event) {
      if(suppressClick.current){suppressClick.current=false;event.preventDefault();event.stopPropagation();}
    },
    onDragStart(event) {event.preventDefault();},
  };
}
