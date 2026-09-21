sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/m/MessageToast",
    "sap/ui/core/routing/History"
], function (Controller, MessageToast, History) {
    "use strict";

    return Controller.extend("conversionfunctions.controller.Detail", {
        onInit: function () {
            var oRouter = sap.ui.core.UIComponent.getRouterFor(this);
            oRouter.getRoute("RouteDetail").attachPatternMatched(this._onObjectMatched, this);
        },

        _onObjectMatched: function (oEvent) {
            var sId = oEvent.getParameter("arguments").id;
            var oView = this.getView();
            var oModel = oView.getModel();
            
            // Use a specific batch group to defer changes until Save
            var sGroupId = "functionGroup";
            
            oView.unbindElement();

            if (sId === "new") {
                // Create new entry using OData V4 bindList().create()
                // using bSkipRefresh=false to ensure it's tracked properly in binding
                // We use standard create. ID is managed by server (UUID).
                this._oListBinding = oModel.bindList("/ConversionFunctions", undefined, undefined, undefined, { $$updateGroupId: sGroupId });
                
                var oInitialData = {
                    name: "", 
                    description: "",
                    serviceUrl: "",
                    inputParams: "",
                    destination: "",
                    method: "GET"
                };

                // Create context. V4 will handle ID generation if configured, or wait for server response.
                // bSkipRefresh=false ensures the list adds the item immediately.
                var oContext = this._oListBinding.create(oInitialData, false); 

                oView.setBindingContext(oContext);
                
                // Keep reference to context
                this._oContext = oContext;
            } else {
                // Bind existing element with the batch group
                var sPath = "/ConversionFunctions(" + sId + ")";
                
                
                oView.bindElement({
                    path: sPath,
                    parameters: {
                        $$updateGroupId: "functionGroup" // Keep batch for updates
                    },
                    events: {
                        dataReceived: function (oData) {
                             if (oData.getParameter("error")) {
                                 console.error("Binding Error:", oData.getParameter("error"));
                             } else {
                                console.log("Binding Success. Data:", oData.getParameter("data"));
                             }
                        }
                    }
                });
            }
        },

        onNavBack: function () {
            var oHistory = History.getInstance();
            var sPreviousHash = oHistory.getPreviousHash();

            if (sPreviousHash !== undefined) {
                window.history.go(-1);
            } else {
                var oRouter = sap.ui.core.UIComponent.getRouterFor(this);
                oRouter.navTo("RouteMain", {}, true);
            }
        },

        onSave: async function () {
            var oModel = this.getView().getModel();
            var sGroupId = "functionGroup";
            
            try {
                // V4: submitBatch returns a Promise
                await oModel.submitBatch(sGroupId);
                
                // Check if any errors occurred during the batch
                if (!oModel.hasPendingChanges(sGroupId)) {
                     MessageToast.show("Saved");
                     this.onNavBack();
                } else {
                     // If changes are still pending, it implies an error prevented success
                     MessageToast.show("Please check input for errors.");
                }
            } catch (e) {
                console.error("Error in onSave:", e);
                MessageToast.show("Error saving: " + e.message);
            }
        },

        onCancel: function () {
             var oModel = this.getView().getModel();
             
             // Reset changes for the group
             oModel.resetChanges("functionGroup");
             
             this.onNavBack();
        }
    });
});
