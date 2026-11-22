export const PREVIEW_PAD = 24;
export const PREVIEW_GAP = 20;

export type PageLayout = {
  offsets: number[];
  total: number;
  heightOf: (page: number) => number;
};

export function buildPageLayout(
  pageCount: number,
  heightOf: (page: number) => number,
  gap = PREVIEW_GAP,
  pad = PREVIEW_PAD,
): PageLayout {
  const offsets = new Array<number>(pageCount + 2).fill(0);
  let cursor = pad;
  for (let page = 1; page <= pageCount; page += 1) {
    offsets[page] = cursor;
    cursor += heightOf(page) + gap;
  }
  const total = pageCount === 0 ? 0 : cursor - gap + pad;
  offsets[pageCount + 1] = total;
  return { offsets, total, heightOf };
}

/** 视口靠上的位置落在哪一页，工具条上的页码就显示哪一页。 */
export function pageAtOffset(layout: PageLayout, pageCount: number, scrollTop: number, probe = 48): number {
  if (pageCount <= 0) return 1;
  const mark = scrollTop + probe;
  let current = 1;
  for (let page = 1; page <= pageCount; page += 1) {
    if (layout.offsets[page] <= mark) current = page;
  }
  return current;
}

export function visiblePageRange(
  layout: PageLayout,
  pageCount: number,
  scrollTop: number,
  viewHeight: number,
  buffer = 1,
): { start: number; end: number } {
  if (pageCount <= 0) return { start: 1, end: 0 };
  const top = scrollTop;
  const bottom = scrollTop + viewHeight;
  let start = 0;
  let end = 0;
  for (let page = 1; page <= pageCount; page += 1) {
    const pageTop = layout.offsets[page];
    const pageHeight = layout.heightOf(page);
    const slack = (pageHeight + PREVIEW_GAP) * buffer;
    if (pageTop + pageHeight + slack >= top && pageTop - slack <= bottom) {
      if (start === 0) start = page;
      end = page;
    }
  }
  if (start === 0) return { start: 1, end: 1 };
  const maxPages = 8;
  if (end - start + 1 > maxPages) {
    const focus = pageAtOffset(layout, pageCount, scrollTop, Math.min(80, viewHeight * 0.3));
    start = Math.max(1, focus - 3);
    end = Math.min(pageCount, start + maxPages - 1);
    start = Math.max(1, end - maxPages + 1);
  }
  return { start, end };
}
