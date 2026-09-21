const cds = require('@sap/cds');
const { getChatbotConfig } = require('./ChatbotConfig');

/**
 * Conversation memory of the chatbot.
 *
 * Two interchangeable back ends implement the same small interface, so the rest of the
 * chat code never knows where the history lives:
 *
 *   - 'db'     -> table db.ChatMessages. Survives restarts and works when the srv
 *                 module is scaled to several instances (see mta.yaml scaling rules),
 *                 which is why it is the default.
 *   - 'memory' -> process local Map. Zero setup, used as automatic fallback whenever
 *                 the database is not reachable (plain node scripts, local runs
 *                 without a deployed model, transient db errors).
 *
 * Only the chat writes and reads these rows: the entity is not exposed in
 * CatalogService, so no existing UI or API is affected.
 */

const ROLE_USER = 'user';
const ROLE_ASSISTANT = 'assistant';

function conversationKey(userId, conversationId) {
    return `${userId || 'anonymous'}::${conversationId}`;
}

function cutoffTimestamp(ttlMinutes) {
    return new Date(Date.now() - Math.max(1, ttlMinutes) * 60 * 1000).toISOString();
}

/* ------------------------------------------------------------------ memory ---- */

const memory = new Map();

const memoryStore = {
    name: 'memory',

    async load(userId, conversationId, { historyLength, historyTtlMinutes }) {
        const entry = memory.get(conversationKey(userId, conversationId));
        if (!entry) return [];

        if (Date.now() - entry.updatedAt > historyTtlMinutes * 60 * 1000) {
            memory.delete(conversationKey(userId, conversationId));
            return [];
        }
        return entry.messages.slice(-historyLength);
    },

    async append(userId, conversationId, messages, { historyLength }) {
        const key = conversationKey(userId, conversationId);
        const entry = memory.get(key) || { messages: [], updatedAt: Date.now() };

        entry.messages = entry.messages.concat(messages).slice(-Math.max(historyLength * 2, 20));
        entry.updatedAt = Date.now();
        memory.set(key, entry);
    },

    async reset(userId, conversationId) {
        memory.delete(conversationKey(userId, conversationId));
    }
};

/* ---------------------------------------------------------------------- db ---- */

/** Lazily resolves the entity: the model is only available once the server is bootstrapped. */
function chatMessagesEntity() {
    try {
        return cds.model?.definitions?.['db.ChatMessages']
            || cds.db?.model?.definitions?.['db.ChatMessages']
            || null;
    } catch (e) {
        return null;
    }
}

const dbStore = {
    name: 'db',

    async load(userId, conversationId, { historyLength, historyTtlMinutes }) {
        const entity = chatMessagesEntity();
        if (!entity) throw new Error('db.ChatMessages is not part of the loaded model');

        const rows = await SELECT.from(entity)
            .columns('role', 'content', 'sequence')
            .where({
                conversationId,
                userId: userId || 'anonymous',
                createdAt: { '>=': cutoffTimestamp(historyTtlMinutes) }
            })
            .orderBy({ sequence: 'desc' })
            .limit(historyLength);

        return rows
            .reverse()
            .map((row) => ({ role: row.role, content: row.content }));
    },

    async append(userId, conversationId, messages) {
        const entity = chatMessagesEntity();
        if (!entity) throw new Error('db.ChatMessages is not part of the loaded model');
        if (!messages.length) return;

        const [max] = await SELECT.from(entity)
            .columns({ func: 'max', args: [{ ref: ['sequence'] }], as: 'maxSequence' })
            .where({ conversationId, userId: userId || 'anonymous' });

        let sequence = Number(max?.maxSequence || 0);

        await INSERT.into(entity).entries(
            messages.map((message) => ({
                conversationId,
                userId: userId || 'anonymous',
                role: message.role,
                content: message.content,
                sequence: ++sequence
            }))
        );
    },

    async reset(userId, conversationId) {
        const entity = chatMessagesEntity();
        if (!entity) return;
        await DELETE.from(entity).where({ conversationId, userId: userId || 'anonymous' });
    }
};

/* ----------------------------------------------------------------- facade ---- */

function resolveStore(config) {
    return config.historyStore === 'memory' ? memoryStore : dbStore;
}

/**
 * Reads back the recent turns of a conversation.
 * @param {string} userId signed-in user the conversation belongs to
 * @param {string} conversationId id of the conversation (session)
 * @returns {Promise<{role: string, content: string}[]>} oldest message first
 */
async function loadHistory(userId, conversationId) {
    const config = getChatbotConfig();
    const store = resolveStore(config);

    try {
        return await store.load(userId, conversationId, config);
    } catch (err) {
        if (store !== memoryStore) {
            console.warn('[Chatbot] History store unavailable, falling back to in-memory history:', err.message);
            return memoryStore.load(userId, conversationId, config);
        }
        console.warn('[Chatbot] Unable to read the conversation history:', err.message);
        return [];
    }
}

/**
 * Appends the turn that just happened. Never throws: losing the memory of a turn must
 * not make the answer fail.
 * @param {string} userId signed-in user the conversation belongs to
 * @param {string} conversationId id of the conversation (session)
 * @param {{role: string, content: string}[]} messages messages to append, in order
 * @returns {Promise<void>} resolved once the turn has been stored (or dropped)
 */
async function appendTurn(userId, conversationId, messages) {
    const config = getChatbotConfig();
    const store = resolveStore(config);
    const valid = (messages || []).filter((m) => m && m.content);

    try {
        await store.append(userId, conversationId, valid, config);
    } catch (err) {
        if (store !== memoryStore) {
            console.warn('[Chatbot] History store unavailable, keeping the turn in memory only:', err.message);
            await memoryStore.append(userId, conversationId, valid, config).catch(() => {});
            return;
        }
        console.warn('[Chatbot] Unable to store the conversation turn:', err.message);
    }
}

/**
 * Forgets a conversation.
 * @param {string} userId signed-in user the conversation belongs to
 * @param {string} conversationId id of the conversation (session)
 * @returns {Promise<void>} resolved once the conversation has been removed
 */
async function resetConversation(userId, conversationId) {
    const config = getChatbotConfig();
    try {
        await resolveStore(config).reset(userId, conversationId);
    } catch (err) {
        console.warn('[Chatbot] Unable to reset the conversation:', err.message);
    }
    await memoryStore.reset(userId, conversationId);
}

module.exports = {
    loadHistory,
    appendTurn,
    resetConversation,
    ROLE_USER,
    ROLE_ASSISTANT
};
