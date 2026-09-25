const cds = require('@sap/cds');
const KnowledgeBaseService = require('../lib/KnowledgeBaseService');

/**
 * KnowledgeBaseHandler
 * CAP adapter of the knowledgebase app: stores the uploaded file and starts the
 * chunking / embedding pipeline (srv/lib/KnowledgeBaseService.js) in background.
 */

/**
 * Starts the processing once the request transaction is committed, so the background
 * job always finds the document row.
 */
function processAfterCommit(req, id) {
    const context = { user: req.user, tenant: req.tenant, locale: req.locale };
    req.on('succeeded', () => {
        setImmediate(() => KnowledgeBaseService.processDocument(id, context));
    });
}

/**
 * Handles `uploadKnowledgeDocument`.
 * @param {object} req the CAP request, `file` is base64 (a data URL prefix is accepted)
 * @returns {Promise<string>} the ID of the new document
 */
async function uploadKnowledgeDocument(req) {
    const { file, fileName } = req.data;
    const config = KnowledgeBaseService.getConfig();

    const extension = KnowledgeBaseService.extensionOf(fileName);
    const mimeType = KnowledgeBaseService.SUPPORTED[extension];
    if (!mimeType) {
        return req.reject(400, 'Formato non supportato: caricare un file .pdf, .docx o .md');
    }
    if (!file) {
        return req.reject(400, 'Il file è vuoto');
    }

    const buffer = Buffer.from(String(file).replace(/^data:[^,]*,/, ''), 'base64');
    if (!buffer.length) {
        return req.reject(400, 'Il file è vuoto');
    }
    if (buffer.length > config.maxFileSizeMb * 1024 * 1024) {
        return req.reject(413, `Il file supera la dimensione massima di ${config.maxFileSizeMb} MB`);
    }

    const id = cds.utils.uuid();
    await INSERT.into('db.KnowledgeDocuments').entries({
        ID: id,
        fileName,
        mimeType,
        fileSize: buffer.length,
        content: buffer,
        status: 'Uploaded'
    });

    processAfterCommit(req, id);
    console.log(`[KnowledgeBase] Document ${id} (${fileName}, ${buffer.length} bytes) uploaded`);
    return id;
}

/**
 * Handles `reprocessKnowledgeDocument`: rebuilds chunks and embeddings of a document.
 */
async function reprocessKnowledgeDocument(req) {
    const { id } = req.data;
    const document = await SELECT.one.from('db.KnowledgeDocuments').columns('ID', 'status').where({ ID: id });
    if (!document) {
        return req.reject(404, 'Documento non trovato');
    }
    if (document.status === 'Processing') {
        return req.reject(409, 'Il documento è già in elaborazione');
    }

    await UPDATE('db.KnowledgeDocuments').set({ status: 'Uploaded', errorMessage: null }).where({ ID: id });
    processAfterCommit(req, id);
    return id;
}

/**
 * Chunks are not part of the service projection, so the deep delete of the
 * composition does not reach them: remove them explicitly with the document.
 */
async function beforeDeleteKnowledgeDocument(req) {
    const id = req.data?.ID;
    if (id) {
        await DELETE.from('db.KnowledgeChunks').where({ document_ID: id });
    }
}

module.exports = {
    uploadKnowledgeDocument,
    reprocessKnowledgeDocument,
    beforeDeleteKnowledgeDocument
};
