import { invoke } from "@tauri-apps/api/core";
import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

function toBytes(value: ArrayBuffer | number[] | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Uint8Array.from(value);
}

class FileRangeTransport extends PDFDataRangeTransport {
  constructor(length: number) {
    super(length, null);
  }

  override requestDataRange(begin: number, end: number): void {
    void invoke<ArrayBuffer | number[]>("read_pdf_range", { begin, end })
      .then((buffer) => {
        this.onDataRange(begin, toBytes(buffer));
      })
      .catch(() => {
        this.onDataRange(begin, new Uint8Array());
      });
  }
}

export type PdfSession = {
  document: PDFDocumentProxy;
  destroy: () => Promise<void>;
};

// JPEG 2000、JBIG2 页面要靠这些解码器，否则整页会画成空白。
const wasmUrl = `${import.meta.env.BASE_URL}pdfjs/wasm/`;

export async function openPdfSession(fileSize: number): Promise<PdfSession> {
  const transport = new FileRangeTransport(fileSize);
  const task = getDocument({
    range: transport,
    disableStream: true,
    disableAutoFetch: true,
    rangeChunkSize: 65536,
    wasmUrl,
  });
  const document = await task.promise;
  return {
    document,
    destroy: () => task.destroy(),
  };
}

export function renderPage(
  document: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale: number,
): { cancel: () => void; done: Promise<{ width: number; height: number }> } {
  let cancelled = false;
  let task: { cancel: () => void; promise: Promise<void> } | null = null;
  const done = (async () => {
    const page = await document.getPage(pageNumber);
    if (cancelled) return { width: 0, height: 0 };
    const viewport = page.getViewport({ scale });
    const outputScale = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    task = page.render({
      canvas,
      viewport,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    });
    await task.promise;
    return { width: viewport.width, height: viewport.height };
  })();
  return {
    cancel: () => {
      cancelled = true;
      task?.cancel();
    },
    done,
  };
}
