const cds = require('@sap/cds');

/**
 * Page context of the chatbot.
 *
 * The UI sends the id of the invoice the user is looking at when the chat is opened
 * (see app/ap_invoice_extraction/webapp/controller/Chatbot.js). This module turns that
 * id into the small set of fields that is worth putting into the system prompt, so the
 * assistant can answer "what is the status of this invoice?" without the user having to
 * repeat the file name - and without the model inventing an answer.
 *
 * Only the short columns are read: `extractedData`, `content`, `pdfContent` and
 * `agentLog` are LargeStrings and would blow up the prompt (and the answer time).
 *
 * Reading the document must never break the chat: a missing id, a deleted document or
 * an unreachable database simply means "no invoice context", not a failed turn.
 */

/** Short columns of db.DocumentStatusBtp that are safe to put into a prompt. */
const CONTEXT_COLUMNS = [
    'id',
    'fileName',
    'invoiceNumber',
    'fornitore',
    'ordine',
    'companyCode',
    'countryCode',
    'scenario',
    'documentType',
    'tipoCaricamento',
    'status',
    'statusBtp',
    'registrationStatus',
    'EbelnGen',
    'createdAt',
    'modifiedAt'
];

/** Lazily resolves the entity: the model is only available once the server is bootstrapped. */
function documentEntity(entities) {
    if (entities?.DocumentStatusBtp) return entities.DocumentStatusBtp;
    try {
        return cds.model?.definitions?.['db.DocumentStatusBtp']
            || cds.db?.model?.definitions?.['db.DocumentStatusBtp']
            || null;
    } catch (e) {
        return null;
    }
}

/**
 * Reads the invoice the user has open in the UI.
 * @param {string} [documentId] key of db.DocumentStatusBtp, as sent by the UI
 * @param {object} [entities] service entities of the current request, when available
 * @returns {Promise<object|null>} the prompt-sized document, or null when there is none
 */
async function loadInvoiceContext(documentId, entities) {
    const id = String(documentId || '').trim();
    if (!id) return null;

    const entity = documentEntity(entities);
    if (!entity) {
        console.warn('[Chatbot] db.DocumentStatusBtp is not reachable, the chat runs without invoice context');
        return null;
    }

    try {
        const [row] = await SELECT.from(entity).columns(CONTEXT_COLUMNS).where({ id }).limit(1);
        if (!row) {
            console.warn(`[Chatbot] Document '${id}' sent by the UI was not found`);
            return null;
        }
        return row;
    } catch (err) {
        console.warn(`[Chatbot] Unable to read the document '${id}':`, err.message);
        return null;
    }
}

module.exports = { loadInvoiceContext, CONTEXT_COLUMNS };
