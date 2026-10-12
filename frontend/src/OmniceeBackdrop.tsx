import { useEffect, useMemo, useState } from "react";
import FaultyTerminal from "./FaultyTerminal";

export type Regime = "bull" | "bear" | "neutral";
const TINT: Record<Regime, string> = { bull: "#00E5A0", bear: "#FF334E", neutral: "#7C879C" };
const GRID_DESKTOP: [number, number] = [2, 1];
const GRID_MOBILE: [number, number] = [1.2, 0.8];

export default function OmniceeBackdrop({ regime }: { regime: Regime }) {
  const [visible, setVisible] = useState(!document.hidden);
  const mobile = useMemo(() => window.matchMedia("(max-width: 768px)").matches, []);
  const reduce = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);

  useEffect(() => {
    const h = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", h);
    return () => document.removeEventListener("visibilitychange", h);
  }, []);

  return (
    <div className="backdrop" aria-hidden="true">
      <FaultyTerminal
        scale={mobile ? 1.2 : 1.5}
        gridMul={mobile ? GRID_MOBILE : GRID_DESKTOP}
        digitSize={1.2}
        timeScale={0.4}
        scanlineIntensity={0.4}
        curvature={mobile ? 0 : 0.1}
        tint={TINT[regime]}
        mouseReact={!mobile}
        mouseStrength={0.4}
        pause={!visible || reduce}
        dpr={mobile ? 1 : Math.min(window.devicePixelRatio || 1, 2)}
        brightness={0.32}
        pageLoadAnimation
      />
      <div className="backdrop-fade" />
    </div>
  );
}
