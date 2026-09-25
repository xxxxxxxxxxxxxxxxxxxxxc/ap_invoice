const cds = require('@sap/cds');
const { Readable } = require('stream');
const PDFService = require('./PDFService');
const { chunkText } = require('./TextChunker');

/**
 * Knowledge base of the chatbot.
 *
 * processDocument() turns an uploaded DOCX/PDF/MD into searchable chunks:
 *   1. text extraction (pdfjs through PDFService, mammoth for DOCX, markdownToText for MD)
 *   2. chunking (TextChunker)
 *   3. embeddings computed INSIDE HANA Cloud by the NLP function VECTOR_EMBEDDING,
 *      so no text leaves the database and no external embedding service is needed.
 *
 * search() is the retrieval side used by the chatbot tool searchKnowledgeBase: the
 * question is embedded with the same model and compared with COSINE_SIMILARITY.
 *
 * Prerequisite: the "Natural Language Processing" additional feature must be enabled
 * on the HANA Cloud instance, otherwise VECTOR_EMBEDDING fails.
 */

const DOCUMENTS = 'db.KnowledgeDocuments';
const CHUNKS = 'db.KnowledgeChunks';

const DEFAULTS = {
    embeddingModel: 'SAP_NEB.20240715',
    chunkSize: 1000,
    chunkOverlap: 150,
    topK: 5,
    maxFileSizeMb: 20
};

const SUPPORTED = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    md: 'text/markdown'
};

function getConfig() {
    let configured = {};
    try {
        configured = cds.env?.knowledgeBase || {};
    } catch (e) {
        configured = {};
    }
    const config = { ...DEFAULTS, ...configured };
    // the model name is inlined in the SQL (VECTOR_EMBEDDING does not take it as a
    // parameter), so it must never contain anything but a model identifier
    if (!/^[A-Za-z0-9_.-]+$/.test(config.embeddingModel)) {
        throw new Error(`Invalid knowledge base embedding model: ${config.embeddingModel}`);
    }
    return config;
}

function isHana() {
    return cds.db?.kind === 'hana';
}

function extensionOf(fileName) {
    const match = /\.([^.]+)$/.exec(String(fileName || ''));
    return match ? match[1].toLowerCase() : '';
}

/** LargeBinary comes back as a Buffer, a stream or (on some drivers) base64. */
async function toBuffer(value) {
    if (!value) return null;
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Readable || typeof value.pipe === 'function') {
        const parts = [];
        for await (const part of value) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
        return Buffer.concat(parts);
    }
    if (typeof value === 'string') return Buffer.from(value, 'base64');
    return Buffer.from(value);
}

/**
 * Strips the Markdown syntax that only adds noise to the embeddings (heading markers,
 * emphasis, link targets, code fences, table separators) and keeps the text. Line
 * breaks are preserved, so headings and list items stay separate units for the chunker.
 */
function markdownToText(markdown) {
    return String(markdown || '')
        .replace(/^\uFEFF/, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/^ {0,3}(```|~~~).*$/gm, '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^ {0,3}#{1,6}\s+/gm, '')
        .replace(/^ {0,3}>\s?/gm, '')
        .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '')
        .replace(/^ {0,3}([-*_])(\s*\1){2,}\s*$/gm, '')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/`([^`]+)`/g, '$1');
}

async function extractText(buffer, fileName) {
    const extension = extensionOf(fileName);
    if (extension === 'md') {
        return markdownToText(buffer.toString('utf8'));
    }
    if (extension === 'docx') {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        return result.value || '';
    }
    if (extension === 'pdf') {
        let result;
        try {
            result = await PDFService.extractTextOrImages(buffer);
        } catch (err) {
            throw new Error(`PDF non leggibile: ${err.message}`);
        }
        if (result.type !== 'text') {
            throw new Error('PDF senza testo estraibile (documento scansionato?): serve un PDF con testo selezionabile.');
        }
        return result.data;
    }
    throw new Error(`Formato non supportato: .${extension}`);
}

/** Runs fn in its own root transaction, committed when fn returns. */
function inNewTx(context, fn) {
    return cds.db.tx({ user: context.user, tenant: context.tenant, locale: context.locale }, fn);
}

async function setStatus(context, id, data) {
    await inNewTx(context, (tx) => tx.run(UPDATE(DOCUMENTS).set(data).where({ ID: id })));
}

/**
 * Extracts, chunks and embeds a knowledge document. Never throws: failures are stored
 * on the document (status 'Error') so the UI can show them.
 * @param {string} id KnowledgeDocuments.ID
 * @param {object} context user / tenant / locale of the request that started it
 */
async function processDocument(id, context = {}) {
    const config = getConfig();
    const started = Date.now();

    try {
        await setStatus(context, id, { status: 'Processing', errorMessage: null, chunkCount: 0 });

        // On HANA the LargeBinary comes back as a stream over a LOB locator, which is
        // valid only while the transaction is open: read it fully before the commit
        const document = await inNewTx(context, async (tx) => {
            const row = await tx.run(SELECT.one.from(DOCUMENTS).columns('ID', 'fileName', 'content').where({ ID: id }));
            if (row) row.content = await toBuffer(row.content);
            return row;
        });
        if (!document) {
            console.warn(`[KnowledgeBase] Document ${id} not found, nothing to process`);
            return;
        }

        const buffer = document.content;
        if (!buffer?.length) throw new Error('Il file caricato è vuoto.');

        const text = await extractText(buffer, document.fileName);
        const chunks = chunkText(text, { chunkSize: config.chunkSize, overlap: config.chunkOverlap });
        if (!chunks.length) throw new Error('Nessun testo trovato nel documento.');

        await inNewTx(context, async (tx) => {
            // reprocessing replaces the previous chunks
            await tx.run(DELETE.from(CHUNKS).where({ document_ID: id }));
            await tx.run(
                INSERT.into(CHUNKS).entries(
                    chunks.map((content, chunkIndex) => ({
                        ID: cds.utils.uuid(),
                        document_ID: id,
                        chunkIndex,
                        content
                    }))
                )
            );

            if (isHana()) {
                // one statement: HANA embeds every chunk of the document with its NLP model
                await tx.run(
                    `UPDATE DB_KNOWLEDGECHUNKS
                        SET EMBEDDING = VECTOR_EMBEDDING(CONTENT, 'DOCUMENT', '${config.embeddingModel}')
                      WHERE DOCUMENT_ID = ?`,
                    [id]
                );
            } else {
                console.warn('[KnowledgeBase] Database is not HANA: chunks stored without embeddings. Use the hybrid profile to test the search.');
            }
        });

        await setStatus(context, id, { status: 'Ready', chunkCount: chunks.length });
        console.log(`[KnowledgeBase] Document ${id} ready: ${chunks.length} chunks in ${Date.now() - started} ms`);
    } catch (err) {
        console.error(`[KnowledgeBase] Processing of document ${id} failed:`, err);
        try {
            await setStatus(context, id, { status: 'Error', errorMessage: String(err?.message || err) });
        } catch (statusErr) {
            console.error(`[KnowledgeBase] Unable to store the error of document ${id}:`, statusErr);
        }
    }
}

/**
 * Semantic search over the chunks of the documents in status 'Ready'.
 * @param {string} query natural language question
 * @param {number} [topK] number of chunks to return
 * @returns {Promise<Array<{fileName: string, chunkIndex: number, score: number, content: string}>>}
 */
async function search(query, topK) {
    if (!isHana()) {
        throw new Error('The knowledge base search needs SAP HANA Cloud (VECTOR_EMBEDDING).');
    }
    const config = getConfig();
    const limit = Math.min(Math.max(parseInt(topK || config.topK, 10) || DEFAULTS.topK, 1), 20);

    const rows = await cds.run(
        `SELECT TOP ${limit}
                d.FILENAME AS "fileName",
                c.CHUNKINDEX AS "chunkIndex",
                COSINE_SIMILARITY(c.EMBEDDING, VECTOR_EMBEDDING(?, 'QUERY', '${config.embeddingModel}')) AS "score",
                c.CONTENT AS "content"
           FROM DB_KNOWLEDGECHUNKS c
           JOIN DB_KNOWLEDGEDOCUMENTS d ON d.ID = c.DOCUMENT_ID
          WHERE d.STATUS = 'Ready' AND c.EMBEDDING IS NOT NULL
          ORDER BY "score" DESC`,
        [query]
    );
    return rows.map((row) => ({ ...row, score: Math.round(Number(row.score) * 1000) / 1000 }));
}

module.exports = {
    processDocument,
    search,
    getConfig,
    extensionOf,
    markdownToText,
    SUPPORTED
};
