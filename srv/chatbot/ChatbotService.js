const cds = require('@sap/cds');
const { getChatbotConfig } = require('./ChatbotConfig');
const { buildSystemPrompt } = require('./ChatbotPrompts');
const { getChatbotTools } = require('./ChatbotTools');
const { loadInvoiceContext } = require('./ChatbotContext');
const ConversationStore = require('./ConversationStore');
const ChatbotAgent = require('./ChatbotAgent');

/**
 * Use case layer of the chatbot: it owns one conversation turn from end to end
 * (validate -> load history -> build prompt and tools -> call the LLM -> persist).
 *
 * The CAP handler only translates the request into a call to `handleMessage()`, so the
 * chat can also be driven from a test script or another protocol without touching CAP.
 *
 * Every failure degrades to a static answer: a broken AI Core connection must never turn
 * into a failing OData action for the user.
 */

const MAX_MESSAGE_LENGTH = 4000;

/**
 * Rejects when the model does not answer in time: the OData action must not stay open
 * for the whole AI Core request timeout, the user would sit in front of a frozen chat.
 */
function withTimeout(promise, timeoutMs) {
    let timer;
    const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`The assistant did not answer within ${timeoutMs} ms`)), timeoutMs);
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** Static answers used when the LLM cannot be reached or is switched off. */
const FALLBACK_REPLIES = {
    en: 'I cannot reach the assistant service right now. Please try again in a few moments.',
    it: 'Non riesco a contattare il servizio di assistenza in questo momento. Riprova tra qualche istante.',
    es: 'No puedo contactar con el servicio de asistencia en este momento. Vuelve a intentarlo en unos instantes.',
    pt: 'Não consigo contactar o serviço de assistência neste momento. Tente novamente dentro de alguns instantes.'
};

const EMPTY_MESSAGE_REPLIES = {
    en: 'Tell me what you need and I will help you.',
    it: 'Dimmi di cosa hai bisogno e ti aiuto.',
    es: 'Dime qué necesitas y te ayudo.',
    pt: 'Diga-me o que precisa e eu ajudo.'
};

function localized(texts, locale) {
    const code = String(locale || '').toLowerCase().split(/[-_]/)[0];
    return texts[code] || texts.en;
}

function newConversationId() {
    return cds.utils.uuid();
}

/**
 * Handles one message of a conversation.
 * @param {object} params turn parameters
 * @param {string} params.message the message typed by the user
 * @param {string} [params.sessionId] conversation the message belongs to; a new one is created when missing
 * @param {string} [params.locale] UI language of the caller (e.g. "it")
 * @param {string} [params.userId] signed-in user, used to scope the conversation
 * @param {string} [params.documentId] invoice the user has open in the UI when chatting
 * @param {object} [params.entities] service entities, forwarded to the tools
 * @param {object} [params.context] extra prompt context (countryCode, companyCode, ...)
 * @returns {Promise<{reply: string, timestamp: string, sessionId: string}>} the assistant answer
 */
async function handleMessage({ message, sessionId, locale, userId, documentId, entities, context = {} } = {}) {
    const config = getChatbotConfig();
    const conversationId = sessionId || newConversationId();
    const timestamp = () => new Date().toISOString();
    const userMessage = String(message || '').trim().substring(0, MAX_MESSAGE_LENGTH);

    if (!userMessage) {
        return {
            reply: localized(EMPTY_MESSAGE_REPLIES, locale),
            timestamp: timestamp(),
            sessionId: conversationId
        };
    }

    if (!config.enabled) {
        console.log('[Chatbot] Disabled by configuration, answering with the static fallback');
        return {
            reply: localized(FALLBACK_REPLIES, locale),
            timestamp: timestamp(),
            sessionId: conversationId
        };
    }

    try {
        // both reads are independent: run them together so the invoice context costs
        // no extra time before the model is called
        const [history, invoice] = await Promise.all([
            ConversationStore.loadHistory(userId, conversationId),
            loadInvoiceContext(documentId, entities)
        ]);

        const tools = getChatbotTools({ userId, locale, entities, documentId, invoice, ...context });

        const systemPrompt = buildSystemPrompt({
            locale,
            userId,
            invoice,
            hasTools: tools.length > 0,
            systemPrompt: config.systemPrompt,
            ...context
        });

        const result = await withTimeout(
            ChatbotAgent.runTurn({
                systemPrompt,
                history,
                message: userMessage,
                tools
            }),
            config.timeoutMs
        );

        const reply = result.reply || localized(FALLBACK_REPLIES, locale);

        if (result.reply) {
            await ConversationStore.appendTurn(userId, conversationId, [
                { role: ConversationStore.ROLE_USER, content: userMessage },
                { role: ConversationStore.ROLE_ASSISTANT, content: reply }
            ]);
        } else {
            console.warn('[Chatbot] The model returned an empty answer, the turn was not stored');
        }

        console.log(
            `[Chatbot] Turn completed | conversation: ${conversationId} `
            + `| invoice: ${invoice?.id || 'none'} | tools used: ${result.toolCalls.length} `
            + `| tokens in/out: ${result.usage.inputTokens}/${result.usage.outputTokens}`
        );

        return { reply, timestamp: timestamp(), sessionId: conversationId };
    } catch (err) {
        console.error('[Chatbot] Turn failed, answering with the static fallback:', err);
        return {
            reply: localized(FALLBACK_REPLIES, locale),
            timestamp: timestamp(),
            sessionId: conversationId
        };
    }
}

/**
 * Forgets a conversation, e.g. when the user starts a new chat.
 * @param {object} params parameters
 * @param {string} params.sessionId conversation to forget
 * @param {string} [params.userId] signed-in user the conversation belongs to
 * @returns {Promise<void>} resolved once the conversation has been removed
 */
async function resetConversation({ sessionId, userId } = {}) {
    if (!sessionId) return;
    await ConversationStore.resetConversation(userId, sessionId);
}

module.exports = {
    handleMessage,
    resetConversation,
    FALLBACK_REPLIES,
    MAX_MESSAGE_LENGTH
};
