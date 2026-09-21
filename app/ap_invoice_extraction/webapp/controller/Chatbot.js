sap.ui.define([
    "sap/ui/core/Fragment",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/base/i18n/Localization"
], function (Fragment, JSONModel, MessageToast, Localization) {
    "use strict";

    /**
     * Single chatbot instance per Component.
     *
     * The popover is created once and attached to the root view instead of the page
     * views: navigating between Home and Detail reuses the very same control, so the
     * fragment can never be instantiated twice (no duplicate IDs) and the conversation
     * is kept while the user moves around the app.
     */

    /**
     * Builds the object that owns the popover and serves as "controller" of the
     * fragment. It is shared by every view, so it must never rely on a concrete
     * view or page controller.
     * @param {sap.ui.core.UIComponent} oComponent the owner component
     * @returns {object} the chatbot instance
     */
    function createInstance(oComponent) {
        return {
            popover: null,
            scroll: null,

            // Conversation the backend keeps the history for. It is created by the
            // first reply and sent back on every following message, so the assistant
            // answers in context instead of seeing every message as the first one.
            sessionId: null,

            // Invoice the user was looking at when the chat was opened. It is refreshed
            // on every toggle and sent along with the message, so the assistant can
            // answer about "this invoice" without the user typing the file name.
            documentId: null,

            text: function (sKey) {
                return oComponent.getModel("i18n").getResourceBundle().getText(sKey);
            },

            addMessage: function (sAuthor, sText) {
                var oModel = this.popover.getModel("chatbot");
                var aMessages = oModel.getProperty("/messages").slice();

                aMessages.push({
                    author: sAuthor,
                    text: sText,
                    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                });

                oModel.setProperty("/messages", aMessages);
                this.scrollToBottom();
            },

            scrollToBottom: function () {
                var oScroll = this.scroll;
                if (!oScroll) {
                    return;
                }
                setTimeout(function () {
                    var oDom = oScroll.getDomRef();
                    if (oDom) {
                        oScroll.scrollTo(0, oDom.scrollHeight, 0);
                    }
                }, 0);
            },

            /**
             * Sends the typed message to the CAP action "chatbotMessage" together with
             * the conversation id and the UI language, then displays the reply.
             */
            onChatbotSend: async function () {
                var oModel = this.popover.getModel("chatbot");
                var sText = (oModel.getProperty("/draft") || "").trim();

                if (!sText) {
                    return;
                }

                this.addMessage("user", sText);
                oModel.setProperty("/draft", "");
                oModel.setProperty("/busy", true);

                try {
                    var oOperation = oComponent.getModel().bindContext("/chatbotMessage(...)");
                    oOperation.setParameter("message", sText);
                    oOperation.setParameter("sessionId", this.sessionId);
                    oOperation.setParameter("locale", Localization.getLanguage());
                    oOperation.setParameter("documentId", this.documentId || null);

                    await oOperation.execute();

                    var oResult = oOperation.getBoundContext().getObject() || {};
                    this.sessionId = oResult.sessionId || this.sessionId;
                    this.addMessage("bot", oResult.reply || this.text("chatbotError"));
                } catch (err) {
                    console.error("Chatbot call failed", err);
                    this.addMessage("bot", this.text("chatbotError"));
                    MessageToast.show(this.text("chatbotError"));
                } finally {
                    oModel.setProperty("/busy", false);
                }
            }
        };
    }

    function loadPopover(oComponent) {
        var oRootView = oComponent.getRootControl();
        var oChatbot = createInstance(oComponent);

        return Fragment.load({
            id: oRootView.getId(),
            name: "apinvoiceextraction.view.ChatbotDialog",
            controller: oChatbot
        }).then(function (oPopover) {
            oChatbot.popover = oPopover;

            oPopover.setModel(new JSONModel({
                messages: [],
                draft: "",
                busy: false
            }), "chatbot");

            // the root view lives as long as the app: it keeps i18n (and the other
            // component models) available inside the fragment and destroys it on exit
            oRootView.addDependent(oPopover);
            oChatbot.scroll = oRootView.byId("chatbotScroll");

            oChatbot.addMessage("bot", oChatbot.text("chatbotWelcome"));

            return oChatbot;
        });
    }

    return {
        /**
         * Opens the chatbot next to the pressed button, or closes it when it is
         * already open. Concurrent presses share the same promise, so the fragment
         * is loaded only once.
         * @param {sap.ui.core.UIComponent} oComponent the owner component
         * @param {sap.ui.core.Control} oOpener the control the popover is anchored to
         * @param {string} [sDocumentId] invoice shown by the page the chat is opened from
         * @returns {Promise} resolved once the popover has been opened or closed
         */
        toggle: function (oComponent, oOpener, sDocumentId) {
            if (!oComponent._pChatbot) {
                oComponent._pChatbot = loadPopover(oComponent);
            }

            return oComponent._pChatbot.then(function (oChatbot) {
                // the popover is shared by every page: refresh the context on each
                // opening, otherwise the chat would keep talking about the invoice
                // the user opened it from the first time
                oChatbot.documentId = sDocumentId || null;

                if (oChatbot.popover.isOpen()) {
                    oChatbot.popover.close();
                } else {
                    oChatbot.popover.openBy(oOpener);
                    oChatbot.scrollToBottom();
                }
            });
        }
    };
});
