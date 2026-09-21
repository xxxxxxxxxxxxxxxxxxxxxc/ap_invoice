sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/m/MessageToast"
], function (Controller, MessageToast) {
    "use strict";

    return Controller.extend("conversionfunctions.controller.Main", {
        onInit: function () {
            var oRouter = sap.ui.core.UIComponent.getRouterFor(this);
            oRouter.getRoute("RouteMain").attachPatternMatched(this._onRouteMatched, this);
        },

        _onRouteMatched: function () {
            // Refresh the table binding to show new/updated entries
            var oTable = this.byId("table");
            if (oTable.getBinding("items")) {
                oTable.getBinding("items").refresh();
            }
        },

        onPress: function (oEvent) {
            var oItem = oEvent.getSource();
            var oRouter = sap.ui.core.UIComponent.getRouterFor(this);
            var sPath = oItem.getBindingContext().getPath();
            // Expected path: /ConversionFunctions(ID)
            // We extract ID. But wait, we can just pass the path substr or the ID
            // Since it's UUID, it's safer to pass the key.
            // Let's rely on standard binding context pattern in Detail.
            // We pass the UUID.
            var sId = oItem.getBindingContext().getProperty("id");
            oRouter.navTo("RouteDetail", {
                id: sId
            });
        },

        onAdd: function () {
            var oRouter = sap.ui.core.UIComponent.getRouterFor(this);
            // Navigate to Detail with a special ID 'new'
             oRouter.navTo("RouteDetail", {
                id: "new"
            });
        },

        onExport: function () {
            var oModel = this.getView().getModel();
            var oListBinding = oModel.bindList("/ConversionFunctions");
            
            oListBinding.requestContexts().then(function (aContexts) {
                var aData = aContexts.map(function (oContext) {
                    return oContext.getObject();
                });
                
                // Remove metadata if present
                var sJson = JSON.stringify(aData, null, 2);
                
                sap.ui.require(["sap/ui/core/util/File"], function (File) {
                    File.save(sJson, "conversion_functions", "json", "application/json");
                });
            }).catch(function (oError) {
                MessageToast.show("Export failed: " + oError.message);
            });
        },

        onImport: function () {
            if (!this._oImportDialog) {
                this._oImportDialog = new sap.m.Dialog({
                    title: "Import Conversion Functions",
                    content: [
                        new sap.ui.unified.FileUploader({
                            id: "fileUploader",
                            fileType: "json",
                            width: "100%",
                            placeholder: "Select JSON file to import..."
                        })
                    ],
                    beginButton: new sap.m.Button({
                        text: "Upload",
                        type: "Emphasized",
                        press: function () {
                            var oFileUploader = this._oImportDialog.getContent()[0];
                            var oFile = oFileUploader.oFileUpload.files[0];
                            if (!oFile) {
                                MessageToast.show("Please select a file first");
                                return;
                            }
                            
                            var reader = new FileReader();
                            reader.onload = function (e) {
                                try {
                                    var aData = JSON.parse(e.target.result);
                                    this._processImport(aData);
                                    this._oImportDialog.close();
                                } catch (err) {
                                    MessageToast.show("Invalid JSON file");
                                }
                            }.bind(this);
                            reader.readAsText(oFile);
                        }.bind(this)
                    }),
                    endButton: new sap.m.Button({
                        text: "Cancel",
                        press: function () {
                            this._oImportDialog.close();
                        }.bind(this)
                    })
                });
                this.getView().addDependent(this._oImportDialog);
            }
            this._oImportDialog.open();
        },

        _processImport: async function (aData) {
            if (!Array.isArray(aData)) {
                MessageToast.show("Invalid data format: Expected an array");
                return;
            }

            var oModel = this.getView().getModel();
            var oListBinding = oModel.bindList("/ConversionFunctions");
            var iCount = 0;
            var iUpdated = 0;
            var iErrors = 0;

            // Load existing contexts to check for duplicates
            // Note: If dataset is large, this might be heavy, but strictly for ConversionFunctions it should be fine.
            try {
                var aContexts = await oListBinding.requestContexts(0, 5000); 
                var aExisting = aContexts.map(function(c) { return c.getObject(); });
                
                aData.forEach(function (oEntry) {
                    try {
                        // Clean up metadata
                        delete oEntry["@odata.context"];
                        delete oEntry["@odata.etag"];
                        
                        var sId = oEntry.id;
                        var oExisting = aExisting.find(function(e) { return e.id === sId; });

                        if (oExisting) {
                            // Update existing
                            // Standard OData V4 Context Binding for Update needed?
                            // Or can we use the context from the list?
                            var oCtx = aContexts.find(function(c) { return c.getProperty("id") === sId; });
                            if (oCtx) {
                                Object.keys(oEntry).forEach(function(key) {
                                    if (key !== "id") { // Don't update key
                                        oCtx.setProperty(key, oEntry[key]);
                                    }
                                });
                                iUpdated++;
                            }
                        } else {
                            // Create New
                            oListBinding.create(oEntry);
                            iCount++;
                        }
                    } catch (e) {
                        iErrors++;
                        console.error("Import error for entry:", oEntry, e);
                    }
                });

                MessageToast.show("Import: " + iCount + " created, " + iUpdated + " updated. Errors: " + iErrors);
                this.byId("table").getBinding("items").refresh();

            } catch (err) {
                console.error("Error loading existing entries", err);
                MessageToast.show("Error during import preparation: " + err.message);
            }
        },

        onDelete: function (oEvent) {
            var oItem = oEvent.getParameter("listItem");
            var oContext = oItem.getBindingContext();
            
            oContext.delete().then(function () {
                MessageToast.show("Deleted");
            }).catch(function (e) {
                MessageToast.show("Error deleting: " + e.message);
            });
        }
    });
});
