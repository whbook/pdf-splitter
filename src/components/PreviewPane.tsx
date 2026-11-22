import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { renderPage } from "../lib/pdfSession";
import { buildPageLayout, pageAtOffset, visiblePageRange } from "../lib/previewLayout";

type Props = {
  document: PDFDocumentProxy | null;
  page: number;
  pageCount: number;
  scale: number;
  reveal: number;
  highlight: { start: number; end: number } | null;
  onPage: (page: number) => void;
  onScale: (scale: number) => void;
};

export function PreviewPane({ document, page, pageCount, scale, reveal, highlight, onPage, onScale }: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  const pageRef = useRef(page);
  const onPageRef = useRef(onPage);
  const scaleRef = useRef(scale);
  const onScaleRef = useRef(onScale);
  const fromScroll = useRef(0);
  const revealRef = useRef(reveal);
  const heightsRef = useRef<Record<number, number>>({});
  const fallbackRef = useRef(0);
  const pageCountRef = useRef(pageCount);
  const epochRef = useRef(0);
  pageRef.current = page;
  onPageRef.current = onPage;
  scaleRef.current = scale;
  onScaleRef.current = onScale;
  pageCountRef.current = pageCount;

  const [fallback, setFallback] = useState(0);
  const [pageWidth, setPageWidth] = useState(0);
  const [heights, setHeights] = useState<Record<number, number>>({});
  const [range, setRange] = useState({ start: 1, end: 1 });
  const [epoch, setEpoch] = useState(0);
  const [error, setError] = useState("");

  heightsRef.current = heights;
  fallbackRef.current = fallback;

  const rememberSize = useCallback((pageNumber: number, width: number, height: number) => {
    if (width > 0) setPageWidth((current) => Math.max(current, width));
    if (height > 0) {
      setHeights((current) => (current[pageNumber] === height ? current : { ...current, [pageNumber]: height }));
    }
  }, []);

  const syncWindow = useCallback((forcePage: number | null) => {
    const frame = frameRef.current;
    const base = fallbackRef.current;
    const count = pageCountRef.current;
    if (!frame || !base || count <= 0) return;
    const known = heightsRef.current;
    const metrics = buildPageLayout(count, (pageNumber) => known[pageNumber] ?? base);
    if (forcePage != null) {
      fromScroll.current = forcePage;
      frame.scrollTop = metrics.offsets[forcePage] ?? 0;
    }
    const probe = Math.min(80, frame.clientHeight * 0.3);
    const current = pageAtOffset(metrics, count, frame.scrollTop, probe);
    if (current !== pageRef.current) {
      fromScroll.current = current;
      onPageRef.current(current);
    }
    const next = visiblePageRange(metrics, count, frame.scrollTop, frame.clientHeight);
    setRange((previous) => (previous.start === next.start && previous.end === next.end ? previous : next));
  }, []);

  useEffect(() => {
    if (!document) {
      setFallback(0);
      setPageWidth(0);
      setHeights({});
      setError("");
      return;
    }
    let cancelled = false;
    setError("");
    void document
      .getPage(1)
      .then((pdfPage) => {
        if (cancelled) return;
        const viewport = pdfPage.getViewport({ scale });
        setHeights({});
        setPageWidth(viewport.width);
        setFallback(viewport.height);
        setEpoch((current) => current + 1);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "页面无法显示。");
      });
    return () => {
      cancelled = true;
    };
  }, [document, scale]);

  useEffect(() => {
    if (!document || !fallback) return;
    const jump = revealRef.current !== reveal || epochRef.current !== epoch || fromScroll.current !== page;
    revealRef.current = reveal;
    epochRef.current = epoch;
    syncWindow(jump ? page : null);
  }, [document, fallback, page, pageCount, epoch, reveal, syncWindow]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !document) return;
    const onScroll = () => syncWindow(null);
    frame.addEventListener("scroll", onScroll, { passive: true });
    return () => frame.removeEventListener("scroll", onScroll);
  }, [document, syncWindow]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || !document) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      let delta = event.deltaY;
      if (event.deltaMode === 1) delta *= 16;
      if (event.deltaMode === 2) delta *= 400;
      const next = Math.min(2.4, Math.max(0.4, scaleRef.current * Math.exp(-delta * 0.0015)));
      if (Math.abs(next - scaleRef.current) < 0.004) return;
      scaleRef.current = next;
      onScaleRef.current(next);
    };
    pane.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => pane.removeEventListener("wheel", onWheel, { capture: true });
  }, [document]);

  async function fitWidth() {
    const frame = frameRef.current;
    if (!frame || !document) return;
    const pdfPage = await document.getPage(pageRef.current || 1);
    const natural = pdfPage.getViewport({ scale: 1 }).width;
    const available = frame.clientWidth - 48;
    if (natural > 0) onScale(Math.min(2.4, Math.max(0.4, available / natural)));
  }

  const metrics = fallback > 0 && pageCount > 0 ? buildPageLayout(pageCount, (pageNumber) => heights[pageNumber] ?? fallback) : null;
  const pages: number[] = [];
  if (metrics) {
    for (let number = range.start; number <= range.end && number <= pageCount; number += 1) pages.push(number);
  }

  return (
    <section className="preview" ref={paneRef}>
      <div className="preview-bar">
        <button type="button" onClick={() => onPage(page - 1)} disabled={!document || page <= 1}>
          上一页
        </button>
        <label>
          第
          <input
            value={document ? page : ""}
            disabled={!document}
            inputMode="numeric"
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isInteger(value)) onPage(Math.min(pageCount, Math.max(1, value)));
            }}
          />
          / {pageCount || "—"} 页
        </label>
        <button type="button" onClick={() => onPage(page + 1)} disabled={!document || page >= pageCount}>
          下一页
        </button>
        <span className="bar-gap" />
        <button type="button" onClick={() => onScale(Math.max(0.4, scale - 0.15))} disabled={!document}>
          缩小
        </button>
        <span className="zoom">{Math.round(scale * 100)}%</span>
        <button type="button" onClick={() => onScale(Math.min(2.4, scale + 0.15))} disabled={!document}>
          放大
        </button>
        <button type="button" onClick={() => void fitWidth()} disabled={!document}>
          适合宽度
        </button>
      </div>
      <div className="preview-frame" ref={frameRef}>
        {document && metrics ? (
          <div className="preview-stack" style={{ height: metrics.total, "--page-w": `${pageWidth}px` } as CSSProperties}>
            {pages.map((number) => (
              <div
                key={number}
                className="preview-slot"
                style={{
                  top: metrics.offsets[number],
                  height: metrics.heightOf(number),
                  width: pageWidth || undefined,
                  marginLeft: pageWidth ? -pageWidth / 2 : undefined,
                }}
              >
                <PageCanvas document={document} pageNumber={number} scale={scale} onSize={rememberSize} />
                {highlight && number >= highlight.start && number <= highlight.end ? <div className="page-mask" /> : null}
                <span className="page-tag page-tag-top">第 {number} 页</span>
                <span className="page-tag page-tag-bottom">第 {number} 页</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="preview-empty">
            <span className="seal seal-large">拆</span>
            <p>{document ? "正在准备页面…" : "打开一本 PDF，从第 1 页开始标出每一章的起止页和标题。"}</p>
          </div>
        )}
        {error ? <p className="preview-error">{error}</p> : null}
      </div>
    </section>
  );
}

function PageCanvas({
  document,
  pageNumber,
  scale,
  onSize,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  onSize: (pageNumber: number, width: number, height: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState("");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let active = true;
    setFailed("");
    const task = renderPage(document, pageNumber, canvas, scale);
    task.done
      .then((size) => {
        if (active && size.height > 0) onSize(pageNumber, size.width, size.height);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        const name = reason instanceof Error ? reason.name : "";
        if (name === "RenderingCancelledException") return;
        setFailed(reason instanceof Error ? reason.message : "这一页无法显示。");
      });
    return () => {
      active = false;
      task.cancel();
    };
  }, [document, pageNumber, scale, onSize]);

  return (
    <>
      <canvas ref={canvasRef} />
      {failed ? <p className="preview-error">{failed}</p> : null}
    </>
  );
}
