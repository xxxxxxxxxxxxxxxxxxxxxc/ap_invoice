sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/core/UIComponent",
    "sap/m/library",
    "sap/ui/model/json/JSONModel",
    "sap/ui/core/Fragment",
    "sap/m/MessageToast",
    "apinvoiceextraction/controller/Chatbot"
], function (Controller, UIComponent, mobileLibrary, JSONModel, Fragment, MessageToast, Chatbot) {
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
         * Opens (or closes) the shared chatbot popover, anchored to the pressed button.
         * The popover lives on the component root view, so it is created only once and
         * survives the navigation between Home and Detail.
         * @param {sap.ui.base.Event} oEvent the press event of the chatbot button
         */
        onOpenChatbot: function (oEvent) {
            Chatbot.toggle(this.getOwnerComponent(), oEvent.getSource(), this.getChatbotDocumentId());
        },

        /**
         * Id of the invoice the current page is showing, sent to the assistant so that
         * questions about "this invoice" are answered on real data. Pages that do not
         * display a single document (e.g. the Home list) return nothing; the Detail
         * controller overrides this method.
         * @returns {string|null} the document id, or null when the page shows no invoice
         */
        getChatbotDocumentId: function () {
            return null;
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
