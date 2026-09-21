sap.ui.define([
    "sap/ui/core/UIComponent",
    "apinvoiceextraction/model/models",
    "sap/ui/model/json/JSONModel"
], function (UIComponent, models, JSONModel) {
    "use strict";

    return UIComponent.extend("apinvoiceextraction.Component", {
        metadata: {
            manifest: "json",
            interfaces: [
                "sap.ui.core.IAsyncContentCreation"
            ]
        },

        init: function () {
            // call the base component's init function
            UIComponent.prototype.init.apply(this, arguments);

            // set the device model
            this.setModel(models.createDeviceModel(), "device");

            // enable routing
            this.getRouter().initialize();
             // set app view model for global state (like selected country)
            var oAppModel = new JSONModel({
                selectedCountryCode: null,
                selectedCountryName: null,
                layout: "OneColumn"
            });
            this.setModel(oAppModel, "appView");
        }
    });
});