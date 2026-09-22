// Shared browser-only layout pass for preview and evaluation exports.
export function fitDocumentText() {

    const results = [];
    const patches = Array.from(document.querySelectorAll('[data-text-patch]'));
    let sourceContext=null,sourceCanvas=null;
    const source=document.querySelector('.source-frame');
    for (const patch of document.querySelectorAll('[data-background-patch]')) {
      if(patch.dataset.backgroundMode==='source'){
        if(source?.complete&&source.naturalWidth){
          if(!sourceContext){sourceCanvas=document.createElement('canvas');sourceCanvas.width=source.naturalWidth;sourceCanvas.height=source.naturalHeight;sourceContext=sourceCanvas.getContext('2d',{willReadFrequently:true});sourceContext.drawImage(source,0,0);}
          const canvas=sourceCanvas,ctx=sourceContext;
          const x=Math.max(0,Math.floor(parseFloat(patch.style.left))),y=Math.max(0,Math.floor(parseFloat(patch.style.top)));
          const w=Math.min(canvas.width-x,Math.ceil(parseFloat(patch.style.width))),h=Math.min(canvas.height-y,Math.ceil(parseFloat(patch.style.height)));
          const cropped=ctx.getImageData(x,y,w,h);
          let top=y>0?ctx.getImageData(x,Math.max(0,y-3),w,1).data:null;
          let bottom=y+h<canvas.height?ctx.getImageData(x,Math.min(canvas.height-1,y+h+2),w,1).data:null;
          if(!top&&!bottom){
            const rgb=getComputedStyle(patch).backgroundColor.match(/[\d.]+/g)?.slice(0,3).map(Number)||[255,255,255];
            top=new Uint8ClampedArray(w*4);for(let xx=0;xx<w;xx++)top.set([...rgb,255],xx*4);
          }
          top=top||bottom;bottom=bottom||top;
          // Reconstruct the complete erase region, including low-contrast
          // antialiasing and JPEG halos. A contrast cutoff leaves readable
          // remnants of the old text behind the replacement.
          for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){
            const offset=(yy*w+xx)*4,t=(yy+3)/(h+5);const bg=[0,1,2].map(k=>top[xx*4+k]*(1-t)+bottom[xx*4+k]*t);
            for(let k=0;k<3;k++)cropped.data[offset+k]=Math.round(bg[k]);
          }
          const tile=document.createElement('canvas');tile.width=w;tile.height=h;tile.getContext('2d').putImageData(cropped,0,0);
          patch.style.backgroundImage=`url("${tile.toDataURL('image/png')}")`;patch.style.backgroundSize='100% 100%';
        }
      }
    }
    for (const patch of patches) {
      const inner = patch.querySelector('.patch-text');
      let size = Number(patch.dataset.fontSize) || 16;
      const MIN = Math.min(size, Math.max(12, Number(patch.dataset.minFontSize) || 12));
      let overflow = 0;
      for (;;) {
        inner.style.fontSize = `${size}px`;
        // Reading scroll/client forces a layout with the new font size.
        const vertical = patch.scrollHeight - patch.clientHeight;
        const horizontal = patch.scrollWidth - patch.clientWidth;
        overflow = Math.max(0, vertical, horizontal);
        if (overflow <= 0.5 || size <= MIN) break;
        size = Math.max(MIN, size - 1);
      }
      results.push({
        id: patch.dataset.editId,
        fits: overflow <= 1,
        fontSize: size,
        overflowPx: Math.ceil(overflow),
      });
    }
    return results;
}
