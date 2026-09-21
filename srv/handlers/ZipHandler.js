const AdmZip = require('adm-zip');
const PDFHandler = require('./PDFHandler');
const XmlHandler = require('./XmlHandler');

module.exports = async function(req, entities) {
    const { DocumentStatusBtp } = entities;
    let base64String = req.data.file;
    
    if (typeof base64String === 'string' && base64String.includes(',')) {
        base64String = base64String.split(',').pop();
    }

    const buffer = Buffer.from(base64String, 'base64');
    let zip;
    try {
        zip = new AdmZip(buffer);
    } catch(e) {
        console.error("ZIP Parsing error:", e);
        return req.error(400, "Invalid ZIP file: " + e.message);
    }

    const zipEntries = zip.getEntries();
    let xmlEntry = null;
    let pdfEntry = null;

    zipEntries.forEach(entry => {
        if (!entry.isDirectory) {
            const name = entry.name.toLowerCase(); // Only check file name, ignore path inside zip
            if (name.endsWith('.xml') && !xmlEntry) xmlEntry = entry;
            if (name.endsWith('.pdf') && !pdfEntry) pdfEntry = entry;
        }
    });

    if (!xmlEntry && !pdfEntry) {
         return req.error(400, "ZIP must contain at least an XML or PDF file");
    }

    if (xmlEntry && pdfEntry) {
        console.log("ZIP Handler: Found both XML and PDF. Processing XML and saving PDF as secondary content.");
        req.data.file = xmlEntry.getData().toString('base64');
        req.data.fileName = xmlEntry.name;
        
        const result = await XmlHandler(req, entities);

        const sJobId = (typeof result === 'object' && result !== null) ? result.jobId : result;

        if (typeof sJobId === 'string' && sJobId.trim().length > 0) {
            const pdfBase64 = pdfEntry.getData().toString('base64');
            await UPDATE(DocumentStatusBtp).set({ pdfContent: pdfBase64 }).where({ id: sJobId });
            console.log("ZIP Handler: Saved PDF content to jobId", sJobId);
            return sJobId;
        }
        
        return sJobId; 
        
    } else if (xmlEntry) {
        console.log("ZIP Handler: Found only XML. Processing via XmlHandler.");
        req.data.file = xmlEntry.getData().toString('base64');
        req.data.fileName = xmlEntry.name;
        return await XmlHandler(req, entities);
    } else if (pdfEntry) {
        console.log("ZIP Handler: Found only PDF. Processing via PDFHandler.");
        req.data.file = pdfEntry.getData().toString('base64');
        req.data.fileName = pdfEntry.name;
        return await PDFHandler(req, entities);
    }
};
