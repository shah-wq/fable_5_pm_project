'use client';

import { useRef, useState } from 'react';

/**
 * Download one chart as a PNG (spec §10, "individual chart download").
 *
 * The chart is already an SVG in the page, so this needs no chart library and no
 * server round trip: serialise the sibling <svg>, draw it on a canvas at 2×, and
 * hand the reader a blob. Two details make the difference between a picture and a
 * blank square:
 *
 *  - width/height must be written onto the serialised copy. The SVG in the page
 *    is sized by CSS, and an <img> loading an SVG with only a viewBox has no
 *    intrinsic size in some browsers.
 *  - the canvas is filled white first. A transparent PNG pasted into a document
 *    with a dark background loses every dark label on the chart.
 *
 * Fonts and colours are attributes on the SVG elements rather than inherited CSS
 * (see charts.tsx), precisely so the exported copy looks like the one on screen.
 */
export function ChartPng({ name }: { name: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function download() {
    const svg = ref.current?.closest('.panel')?.querySelector('svg.chart-svg');
    if (!(svg instanceof SVGSVGElement)) {
      setFailed(true);
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      const box = svg.viewBox.baseVal;
      const w = box.width || svg.clientWidth || 720;
      const h = box.height || svg.clientHeight || 300;

      const copy = svg.cloneNode(true) as SVGSVGElement;
      copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      copy.setAttribute('width', String(w));
      copy.setAttribute('height', String(h));

      const url = URL.createObjectURL(
        new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' })
      );
      try {
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('svg did not load'));
          img.src = url;
        });

        const scale = 2;
        const canvas = document.createElement('canvas');
        canvas.width = w * scale;
        canvas.height = h * scale;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.drawImage(img, 0, 0, w, h);

        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('canvas produced nothing');

        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
        a.click();
        URL.revokeObjectURL(href);
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      ref={ref}
      className="chart-png"
      type="button"
      onClick={download}
      disabled={busy}
      title={`Download “${name}” as a PNG`}
    >
      {busy ? 'Saving…' : failed ? 'Use Print instead' : 'PNG'}
    </button>
  );
}
