const path = require('path');
// Risolviamo i path una sola volta per tutto il modulo (funziona anche su v4.x)
const pdfjsDistPath = path.dirname(require.resolve('pdfjs-dist/package.json'));
const CMAP_URL = path.join(pdfjsDistPath, 'cmaps').replace(/\\/g, '/') + '/';
const STANDARD_FONTS_URL = path.join(pdfjsDistPath, 'standard_fonts').replace(/\\/g, '/') + '/';
class PDFService {
    constructor() {
    }

    /**
     * Extracts text from PDF using pdf-parse. 
     * If the PDF is a scan (little to no text), it falls back to converting it to Base64 images.
     * @param {Buffer} pdfBuffer 
     * @returns {Promise<{type: string, data: string | string[]}>} Object containing either text ('text') or array of Base64 strings ('images')
     */
    async extractTextOrImages(pdfBuffer) {
        try {
            // Importazione dinamica per la v4.x (sostituisce il vecchio require)
            const pdfjsLib = await import('pdfjs-dist');

            const dataUint8Array = new Uint8Array(pdfBuffer);

            // Carichiamo il documento iniettando i font e le mappe caratteri per CJK
            const loadingTask = pdfjsLib.getDocument({
                data: dataUint8Array,
                cMapUrl: CMAP_URL,
                cMapPacked: true,
                standardFontDataUrl: STANDARD_FONTS_URL,
                useSystemFonts: true
            });

            const pdfDocument = await loadingTask.promise;
            let textContent = "";

            // Estraiamo il testo ciclando su ogni singola pagina
            for (let i = 1; i <= pdfDocument.numPages; i++) {
                const page = await pdfDocument.getPage(i);
                const textData = await page.getTextContent();
                const pageText = textData.items.map(item => item.str).join(' ');
                textContent += pageText + '\n';
            }

            textContent = textContent.trim();

            //Vecchio
            // Try to extract text first using pdf-parse
            /*         const pdfParse = require('pdf-parse');
                     const parsedData = await pdfParse(pdfBuffer);
                     const textContent = parsedData.text ? parsedData.text.trim() : "";*/
            //Vecchio pdf parse

            // Heuristic to detect if it's a scanned PDF
            // A typical invoice should have at least some reasonable amount of text characters
            if (textContent.length > 50) {
                console.log(`[PDFService] Extracted ${textContent.length} characters directly from PDF.`);
                return { type: 'text', data: textContent, error: "Ho estratto del testo" };
            }

            console.log("[PDFService] PDF contains little to no text, treating as scan (falling back to images).");
            const images = await this.convertPdfToImages(pdfBuffer);
            return { type: 'images', data: images, error: "[PDFService] PDF contains little to no text, treating as scan (falling back to images)." };
        } catch (error) {
            console.error("[PDFService] 🚨 CRITICAL ERROR parsing PDF text:", error);
            console.error("[PDFService] Falling back to images due to parsing failure.");
            const images = await this.convertPdfToImages(pdfBuffer);
            return { type: 'images', data: images, error: error };
        }
    }

    /**
     * Converts a PDF buffer to an array of images (Base64).
     * @param {Buffer} pdfBuffer 
     * @returns {Promise<string[]>} Array of Base64 strings (one per page)
     */
    async convertPdfToImages(pdfBuffer) {
        try {
            const pdfModule = await import('pdf-to-img');
            const convert = pdfModule.pdf || pdfModule.default?.pdf || pdfModule.default;

            // 1. Convertiamo il Buffer in Uint8Array anche per pdf-to-img
            const dataUint8Array = new Uint8Array(pdfBuffer);

            const document = await convert(dataUint8Array, {
                scale: 1.5,
                cMapUrl: CMAP_URL,
                cMapPacked: true,
                standardFontDataUrl: STANDARD_FONTS_URL
            });

            const base64Images = [];

            for await (const image of document) {
                base64Images.push(image.toString('base64'));
            }

            return base64Images;
        } catch (error) {
            console.error("PDF Conversion Error:", error);
            throw new Error("Failed to convert PDF to images: " + error.message);
        }
    }
}

module.exports = new PDFService();
