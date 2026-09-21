const ChatbotService = require('../chatbot/ChatbotService');

/**
 * ChatbotHandler
 * Thin CAP adapter for the chatbot conversation coming from the AP Invoice Extraction UI.
 *
 * It only translates the OData request into a call to the chat use case layer
 * (srv/chatbot): the conversation logic, the prompts, the tools and the history live
 * there and have no dependency on CAP.
 */

/**
 * Handles the `chatbotMessage` action.
 * @param {object} req the CAP request
 * @param {object} [entities] the service entities, forwarded to the chatbot tools
 * @returns {Promise<{reply: string, timestamp: string, sessionId: string}>} the assistant answer
 */
async function chatbotMessage(req, entities) {
    const { message, sessionId, documentId } = req.data;
    const locale = req.data.locale || req.locale;
    const userId = req.user?.id;

    console.log(
        `Chatbot - messaggio ricevuto (sessione ${sessionId || 'nuova'}, `
        + `documento ${documentId || 'nessuno'}):`,
        message
    );

    return ChatbotService.handleMessage({
        message,
        sessionId,
        locale,
        userId,
        // invoice the user is looking at when the chat is opened: it lets the assistant
        // answer about "this invoice" without the user spelling out the file name
        documentId,
        entities
    });
}

module.exports = { chatbotMessage };
