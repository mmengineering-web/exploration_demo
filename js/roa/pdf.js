// Browser adapter: PDF file -> pages[{items:[{x,y,w,str}]}] for parse.js. pdf.js is loaded on first use (kept out of the startup path).
let lib;
async function load() {
  if (lib) return lib;
  lib = await import('../vendor/pdf.min.mjs');
  lib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  return lib;
}
export async function readPdf(file) {
  const pdfjs = await load();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    pages.push({ items: tc.items.filter(t => t.str.trim()).map(t => ({ x: t.transform[4], y: t.transform[5], w: t.width, str: t.str })) });
  }
  await doc.destroy();
  return pages;
}
