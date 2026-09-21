/**
 * ChatbotHandler
 * Handles the chatbot conversation coming from the AP Invoice Extraction UI.
 * For now the assistant always answers with a fixed message: the real
 * AI integration will replace the body of chatbotMessage().
 */

const FIXED_REPLY = "Ciao! Sono l'assistente virtuale di AP Invoice Extraction. Al momento sono in fase di configurazione, ma presto potrò aiutarti con le tue fatture.";

async function chatbotMessage(req) {
    const sMessage = (req.data.message || "").trim();
    console.log("Chatbot - messaggio ricevuto:", sMessage);

    return {
        reply: FIXED_REPLY,
        timestamp: new Date().toISOString()
    };
}

module.exports = { chatbotMessage, FIXED_REPLY };
