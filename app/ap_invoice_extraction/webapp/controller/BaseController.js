sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/core/UIComponent",
    "sap/m/library",
    "sap/ui/model/json/JSONModel",
    "sap/ui/core/Fragment",
    "sap/m/MessageToast"
], function (Controller, UIComponent, mobileLibrary, JSONModel, Fragment, MessageToast) {
    "use strict";

    // shortcut for sap.m.URLHelper
    var URLHelper = mobileLibrary.URLHelper;

    return Controller.extend("apinvoiceextraction.controller.BaseController", {
        /**
         * Convenience method for accessing the router.
         * @public
         * @returns {sap.ui.core.routing.Router} the router for this component
         */
        getRouter: function () {
            return UIComponent.getRouterFor(this);
        },

        /**
         * Convenience method for getting the view model by name.
         * @public
         * @param {string} [sName] the model name
         * @returns {sap.ui.model.Model} the model instance
         */
        getModel: function (sName) {
            return this.getView().getModel(sName);
        },

        /**
         * Convenience method for setting the view model.
         * @public
         * @param {sap.ui.model.Model} oModel the model instance
         * @param {string} sName the model name
         * @returns {sap.ui.mvc.View} the view instance
         */
        setModel: function (oModel, sName) {
            return this.getView().setModel(oModel, sName);
        },

        /**
         * Getter for the resource bundle.
         * @public
         * @returns {sap.ui.model.resource.ResourceModel} the resourceModel of the component
         */
        getResourceBundle: function () {
            return this.getOwnerComponent().getModel("i18n").getResourceBundle();
        },

        /**
         * Helper method to open Country Selection Dialog
         */
        openCountrySelectionDialog: function () {
            var oView = this.getView();
            var oDialog = oView.byId("countrySelectionDialog");

            // create dialog lazily
            if (!oDialog) {
                // load asynchronous XML fragment
                Fragment.load({
                    id: oView.getId(),
                    name: "apinvoiceextraction.view.CountrySelectionDialog",
                    controller: this
                }).then(function (oLoadedDialog) {
                     oView.addDependent(oLoadedDialog);
                     oLoadedDialog.open();
                });
            } else {
                oDialog.open();
            }
        },

        /**
         * Event handler for country selection
         */
        onCountrySelect: function(oEvent) {
            var oSelectedItem = oEvent.getParameter("selectedItem");
            if (oSelectedItem) {
                var oContext = oSelectedItem.getBindingContext("allowedCountries");
                var sCountryCode = oContext.getProperty("code");
                var sCountryName = oContext.getProperty("name");
                
                var oAppModel = this.getOwnerComponent().getModel("appView");
                oAppModel.setProperty("/selectedCountryCode", sCountryCode);
                oAppModel.setProperty("/selectedCountryName", sCountryName);
                
                this._onCountrySelected(sCountryCode);
            }
        },
        
        // To be overridden by subclasses if specific action needed
        _onCountrySelected: function(sCountryCode) {
            // Default: just close dialog? 
            // The SelectDialog closes automatically on select usually, 
            // but if we used a Dialog with a List, we might need to close it.
        },

        /* ======================= CHATBOT ======================= */

        /**
         * Opens the chatbot as a small non-modal popover anchored to the pressed icon,
         * so the application behind stays visible and usable.
         * @param {sap.ui.base.Event} oEvent the press event of the chatbot icon
         */
        onOpenChatbot: function (oEvent) {
            var oView = this.getView();
            var oSource = oEvent.getSource();

            if (!oView.getModel("chatbot")) {
                oView.setModel(new JSONModel({
                    messages: [],
                    draft: "",
                    busy: false
                }), "chatbot");
            }

            var oPopover = oView.byId("chatbotPopover");
            if (!oPopover) {
                Fragment.load({
                    id: oView.getId(),
                    name: "apinvoiceextraction.view.ChatbotDialog",
                    controller: this
                }).then(function (oLoadedPopover) {
                    oView.addDependent(oLoadedPopover);
                    this._greetChatbot();
                    oLoadedPopover.openBy(oSource);
                }.bind(this));
            } else if (oPopover.isOpen()) {
                oPopover.close();
            } else {
                oPopover.openBy(oSource);
            }
        },

        /**
         * Pushes the welcome message the first time the dialog is opened.
         */
        _greetChatbot: function () {
            var oModel = this.getView().getModel("chatbot");
            if (oModel.getProperty("/messages").length === 0) {
                this._addChatbotMessage("bot", this.getResourceBundle().getText("chatbotWelcome"));
            }
        },

        /**
         * Appends a message to the conversation and scrolls to the bottom.
         * @param {string} sAuthor "user" or "bot"
         * @param {string} sText the message body
         */
        _addChatbotMessage: function (sAuthor, sText) {
            var oModel = this.getView().getModel("chatbot");
            var aMessages = oModel.getProperty("/messages").slice();

            aMessages.push({
                author: sAuthor,
                text: sText,
                time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            });

            oModel.setProperty("/messages", aMessages);
            this._scrollChatbotToBottom();
        },

        _scrollChatbotToBottom: function () {
            var oScroll = this.getView().byId("chatbotScroll");
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
         * Sends the typed message to the CAP action "chatbotMessage"
         * and displays the reply returned by the backend.
         */
        onChatbotSend: async function () {
            var oModel = this.getView().getModel("chatbot");
            var sText = (oModel.getProperty("/draft") || "").trim();

            if (!sText) {
                return;
            }

            this._addChatbotMessage("user", sText);
            oModel.setProperty("/draft", "");
            oModel.setProperty("/busy", true);

            try {
                var oODataModel = this.getOwnerComponent().getModel();
                var oOperation = oODataModel.bindContext("/chatbotMessage(...)");
                oOperation.setParameter("message", sText);

                await oOperation.execute();

                var oResult = oOperation.getBoundContext().getObject() || {};
                this._addChatbotMessage("bot", oResult.reply || this.getResourceBundle().getText("chatbotError"));
            } catch (err) {
                console.error("Chatbot call failed", err);
                this._addChatbotMessage("bot", this.getResourceBundle().getText("chatbotError"));
                MessageToast.show(this.getResourceBundle().getText("chatbotError"));
            } finally {
                oModel.setProperty("/busy", false);
            }
        },

        /**
         * Search handler for the country dialog
         */
        onCountrySearch: function (oEvent) {
            var sValue = oEvent.getParameter("value");
            var oFilter = new sap.ui.model.Filter("name", sap.ui.model.FilterOperator.Contains, sValue);
            var oBinding = oEvent.getParameter("itemsBinding");
            oBinding.filter([oFilter]);
        }
    });
});
