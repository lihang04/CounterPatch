"use client";

import { useEffect } from "react";

// Sets <html data-hydrated> once client code is live, so browser automation
// can wait for interactivity instead of racing hydration.
export function HydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);
  return null;
}
