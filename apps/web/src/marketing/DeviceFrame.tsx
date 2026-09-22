/**
 * Uniform device scaling for the landing previews.
 *
 * The renderer is authored at a fixed logical device width (iPhone 17 Pro,
 * 402 × 874). Previews must never shrink the container, because that rewraps
 * the conversation and produces the broken screenshots this project set out to
 * avoid. Instead the whole frame is transformed by one scale factor derived
 * from the available column width, so every preview keeps the original layout.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface DeviceSize {
  width: number;
  height: number;
}

export const DEMO_DEVICE: DeviceSize = { width: 402, height: 874 };
export const DEVICE_BEZEL = 9;

function useUniformScale(naturalWidth: number): { hostRef: React.RefObject<HTMLDivElement | null>; scale: number } {
  const hostRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      const available = host.clientWidth;
      if (available > 0) setScale(Math.min(1, available / naturalWidth));
    };
    update();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(update);
      observer.observe(host);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [naturalWidth]);

  return { hostRef, scale };
}

export interface ScaledSceneFrameProps {
  size?: DeviceSize;
  label?: string;
  children: ReactNode;
}

/** A frame that renders at natural size and scales uniformly to fit its column. */
export function ScaledSceneFrame({ size = DEMO_DEVICE, label, children }: ScaledSceneFrameProps) {
  const frameWidth = size.width + DEVICE_BEZEL * 2;
  const frameHeight = size.height + DEVICE_BEZEL * 2;
  const { hostRef, scale } = useUniformScale(frameWidth);

  return (
    <div className="mark-phone-host" ref={hostRef} style={{ height: (frameHeight * scale).toFixed(2) + 'px' }} data-scale={scale.toFixed(3)}>
      <div className="mark-phone-scale" style={{ transform: `translateX(-50%) scale(${scale})`, width: frameWidth, height: frameHeight }}>
        <div className="mark-phone-frame" style={{ width: frameWidth, height: frameHeight, padding: DEVICE_BEZEL }} role="group" aria-label={label}>
          {children}
        </div>
      </div>
    </div>
  );
}

export interface ExportStageProps {
  children: ReactNode;
  size?: DeviceSize;
  nodeRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Off-screen natural-size render used only for PNG export and previews. It is
 * positioned (not hidden) so `html-to-image` can read real layout boxes, and it
 * is `aria-hidden` because it duplicates visible content.
 */
export function ExportStage({ children, size = DEMO_DEVICE, nodeRef }: ExportStageProps) {
  return (
    <div className="mark-export-host" aria-hidden="true">
      <div className="mark-export-frame" ref={nodeRef} style={{ width: size.width, height: size.height }}>
        {children}
      </div>
    </div>
  );
}
