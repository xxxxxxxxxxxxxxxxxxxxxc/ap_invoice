/**
 * Splits a plain text into overlapping chunks for the knowledge base embeddings.
 *
 * The text is cut on the most natural boundary available: paragraphs first, then
 * sentences, then words, and only as a last resort in the middle of a word. Chunks are
 * kept small on purpose: the HANA embedding model (SAP_NEB) reads a limited number of
 * tokens and silently truncates the rest, so a long chunk would lose its tail.
 *
 * Every chunk after the first starts with the tail of the previous one (`overlap`
 * characters), so a sentence split across two chunks is still found by the search.
 */

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_OVERLAP = 150;

function normalize(text) {
    return String(text || '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t\f\v ]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Cuts a piece longer than `size` on word boundaries (hard cut for endless words). */
function splitLong(piece, size) {
    const parts = [];
    let rest = piece;
    while (rest.length > size) {
        let cut = rest.lastIndexOf(' ', size);
        if (cut <= 0) cut = size;
        parts.push(rest.substring(0, cut).trim());
        rest = rest.substring(cut).trim();
    }
    if (rest) parts.push(rest);
    return parts;
}

/** Breaks the text into units no longer than `size`: paragraphs, sentences, words. */
function toUnits(text, size) {
    const units = [];
    for (const paragraph of text.split(/\n+/)) {
        const value = paragraph.trim();
        if (!value) continue;
        if (value.length <= size) {
            units.push(value);
            continue;
        }
        for (const sentence of value.split(/(?<=[.!?;:])\s+/)) {
            if (sentence.length <= size) {
                units.push(sentence);
            } else {
                units.push(...splitLong(sentence, size));
            }
        }
    }
    return units;
}

/** Last `overlap` characters of a chunk, starting on a word boundary. */
function tail(chunk, overlap) {
    if (overlap <= 0 || chunk.length <= overlap) return overlap > 0 ? chunk : '';
    const start = chunk.indexOf(' ', chunk.length - overlap);
    return start < 0 ? '' : chunk.substring(start + 1);
}

/**
 * @param {string} text the document text
 * @param {object} [options]
 * @param {number} [options.chunkSize] maximum characters of a chunk
 * @param {number} [options.overlap] characters repeated from the previous chunk
 * @returns {string[]} the chunks, in document order
 */
function chunkText(text, options = {}) {
    const size = Math.max(100, options.chunkSize || DEFAULT_CHUNK_SIZE);
    const overlap = Math.min(Math.max(0, options.overlap ?? DEFAULT_OVERLAP), Math.floor(size / 2));

    const units = toUnits(normalize(text), size - overlap - 1);
    const chunks = [];
    let current = '';

    for (const unit of units) {
        if (current && current.length + 1 + unit.length > size) {
            chunks.push(current);
            const carried = tail(current, overlap);
            current = carried ? `${carried} ${unit}` : unit;
        } else {
            current = current ? `${current} ${unit}` : unit;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

module.exports = { chunkText };
