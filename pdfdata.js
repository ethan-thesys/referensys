// Keeps an SOP to one file: the editable version rides inside the PDF as a standard PDF attachment.
// PDF viewers show the normal document; Referensys reads the attachment back to edit the steps.
// The attachment holds the same redacted screenshots and text that the PDF itself shows.
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } = require('pdf-lib');
const NAME = 'referensys-sop.json';

async function embed(pdfBytes, projectText) {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  await doc.attach(Buffer.from(projectText, 'utf8'), NAME, { mimeType: 'application/json', description: 'Referensys editable SOP', modificationDate: new Date() });
  doc.setProducer('Referensys');
  return Buffer.from(await doc.save());
}

async function extract(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const files = names && names.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  if (!files) return null;
  const walk = node => {
    const arr = node.lookupMaybe(PDFName.of('Names'), PDFArray);
    if (arr) for (let i = 0; i + 1 < arr.size(); i += 2) {
      const key = arr.lookup(i); const nm = key && key.decodeText ? key.decodeText() : '';
      if (nm !== NAME) continue;
      const ef = arr.lookup(i + 1, PDFDict).lookupMaybe(PDFName.of('EF'), PDFDict);
      const st = ef && ef.lookup(PDFName.of('F'));
      if (st instanceof PDFRawStream) return Buffer.from(decodePDFRawStream(st).decode()).toString('utf8');
      if (st && st.getContents) return Buffer.from(st.getContents()).toString('utf8');
    }
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) for (let i = 0; i < kids.size(); i++) { const r = walk(kids.lookup(i, PDFDict)); if (r) return r; }
    return null;
  };
  return walk(files);
}

const isPdf = buf => buf.length > 4 && buf.slice(0, 5).toString('latin1') === '%PDF-';
module.exports = { embed, extract, isPdf };
