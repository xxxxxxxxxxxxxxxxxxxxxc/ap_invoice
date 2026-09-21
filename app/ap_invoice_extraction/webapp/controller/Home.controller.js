sap.ui.define([
    "apinvoiceextraction/controller/BaseController",
    "sap/ui/model/json/JSONModel",
    "apinvoiceextraction/model/formatter",
    "sap/m/MessageToast",
    "sap/m/MessageBox"
], function (BaseController, JSONModel, formatter, MessageToast, MessageBox) {

    "use strict";

    return BaseController.extend("apinvoiceextraction.controller.Home", {

        formatter: formatter,

        onInit: function () {

            /** MODELLO INTERNO */
            const oLocal = new JSONModel({
                defaultDate: this._getOneMonthAgo(),
                busy: false,
                selectedCountry: null
            });
            this.getView().setModel(oLocal, "local");

            /** ROUTING */
            this.getRouter()
                .getRoute("RouteHome")
                .attachPatternMatched(this._onRouteMatched, this);

            /** LISTEN TO COUNTRY CHANGE */
            // We need to listen to changes in the appView model /selectedCountryCode
            // triggering a refresh of the list even if the route doesn't change.
            const oApp = this.getOwnerComponent().getModel("appView");
            if (oApp) {
                // Bind to the property and attach change handler
                const oBinding = oApp.bindProperty("/selectedCountryCode");
                oBinding.attachChange(this._onCountryChanged, this);
            }
        },

        _onCountryChanged: function(oEvent) {
             const sCountry = oEvent.getSource().getValue();
             this._applyCountryFilter(sCountry);
        },

        _applyCountryFilter: function(sCountry) {
            const oTable = this.byId("DocumentTable");
            const oBinding = oTable.getBinding("items");
            
            // Update local model for display/logic
            this.getView().getModel("local").setProperty("/selectedCountry", sCountry);

            if (!sCountry) {
                 if (oBinding) oBinding.filter(new sap.ui.model.Filter("countryCode", "EQ", "___"));
                 return;
            }

            if (oBinding) {
                oBinding.filter(new sap.ui.model.Filter("countryCode", "EQ", sCountry));
            }
        },

        /** Calcola data 1 mese prima */
        _getOneMonthAgo: function () {
            const d = new Date();
            d.setMonth(d.getMonth() - 1);
            return d;
        },

        _onRouteMatched: async function () {
            const oComponent = this.getOwnerComponent();
            if (!oComponent) return;

            const oApp = oComponent.getModel("appView");
            if (!oApp) {
                return;
            }

            const sCountry = oApp.getProperty("/selectedCountryCode");

            if (!sCountry) {
                this._applyCountryFilter(null);
                await this._checkAllowedCountriesAndOpenDialog();
                return;
            }

            this._applyCountryFilter(sCountry);
        },

        _checkAllowedCountriesAndOpenDialog: async function () {
            const oComponent = this.getOwnerComponent();
            const oModel = this.getView().getModel();
            const oContext = oModel.bindContext("/getUserAllowedCountries(...)");
            const oLocalModel = this.getView().getModel("local");
            oLocalModel.setProperty("/busy", true);
            try {
                await oContext.execute();
                const oAllowed = oContext.getBoundContext().getObject();
                const aCountries = oAllowed && oAllowed.value ? oAllowed.value : [];
                
                if (aCountries.length === 1) {
                    const oCountry = aCountries[0];
                    const oAppModel = oComponent.getModel("appView");
                    oAppModel.setProperty("/selectedCountryCode", oCountry.code);
                    oAppModel.setProperty("/selectedCountryName", oCountry.name);
                } else if (aCountries.length > 1) {
                    const oAllowedModel = new JSONModel(aCountries);
                    oComponent.setModel(oAllowedModel, "allowedCountries");
                    this.openCountrySelectionDialog();
                } else {
                    MessageBox.error(this.getResourceBundle().getText("noCountriesEnabled"));
                }
            } catch (err) {
                MessageBox.error(err.message);
            } finally {
                oLocalModel.setProperty("/busy", false);
            }
        },

        // ... existing navigation ...

        onSearch: function (oEvent) {
             const sQuery = oEvent.getParameter("query");
             const oTable = this.byId("DocumentTable");
             const oBinding = oTable.getBinding("items");
             
             // Get current Country from local model (set in _onRouteMatched)
             const sCountry = this.getView().getModel("local").getProperty("/selectedCountry");

             const aFilters = [];
             
             // Always filter by Country if selected
             if (sCountry) {
                aFilters.push(new sap.ui.model.Filter("countryCode", "EQ", sCountry));
             } else {
                 // If no country, keep it empty
                 aFilters.push(new sap.ui.model.Filter("countryCode", "EQ", "___"));
             }

             if (sQuery) {
                 aFilters.push(new sap.ui.model.Filter("fileName", sap.ui.model.FilterOperator.Contains, sQuery));
             }
             
             // Apply filters with "Wait for result" implicitly handled by OData V4
             // Note: if multiple filters, default is AND
             if (aFilters.length > 0) {
                 oBinding.filter(new sap.ui.model.Filter({
                     filters: aFilters,
                     and: true
                 }));
             } else {
                 oBinding.filter([]); 
             }
        },

        onOpenUploadDialog: function () {
            // Use loadFragment for Async loading (better for CSP)
            if (!this._oUploadDialog) {
                this.loadFragment({
                    name: "apinvoiceextraction.view.UploadDialog"
                }).then(function(oDialog) {
                    this._oUploadDialog = oDialog;
                    this.getView().addDependent(this._oUploadDialog); // Check this
                    this._openDialogInternal();
                }.bind(this)).catch(function(err) {
                    MessageBox.error(this.getResourceBundle().getText("errorLoadUploadDialog") + err.message);
                }.bind(this));
            } else {
                this._openDialogInternal();
            }
        },

        onCompanyCodeChange: function(oEvent) {
            // Optional logic when company code changes
        },

        _openDialogInternal: async function() {
            // Reset fields
            this.byId("fileUploaderDialog").setValue("");
            const oCB = this.byId("cbCompanyCode");
            
            if (oCB) {
                oCB.setSelectedKey(null);
            }

            this._oUploadDialog.open();

            // Filter Company Codes based on selected Country
            const sCountry = this.getView().getModel("local").getProperty("/selectedCountry");
            
            if (sCountry && oCB) {
                const oBinding = oCB.getBinding("items");
                oBinding.filter(new sap.ui.model.Filter("country_code", "EQ", sCountry));

                // Pre-select if only 1 Company Code exists
                try {
                    const aContexts = await oBinding.requestContexts();
                    if (aContexts && aContexts.length === 1) {
                        const sCode = aContexts[0].getObject().companyCode;
                        oCB.setSelectedKey(sCode);
                    }
                } catch (e) {
                    console.warn("Auto-selection of company code failed", e);
                }
            }
        },

        onCancelUpload: function () {
            this._oUploadDialog.close();
        },

        onConfirmUpload: async function () {
             const oUploader = this.byId("fileUploaderDialog");
             const oCB = this.byId("cbCompanyCode");
             
             let sCompanyCode = null;
             if (oCB) {
                sCompanyCode = oCB.getSelectedKey();
             }

             const oFile = oUploader?.oFileUpload?.files?.[0];
             
             // Validation: Only check Company Code if control is visible/present
             if (oCB && !sCompanyCode) {
                 MessageToast.show(this.getResourceBundle().getText("msgSelectCompanyCode"));
                 return;
             }
             if (!oFile) {
                 MessageToast.show(this.getResourceBundle().getText("msgSelectFile"));
                 return;
             }

             this._oUploadDialog.close();

             // Reuse existing logic, but adapted
             const sCountryCode = this.getView().getModel("local").getProperty("/selectedCountry");
             await this._performUpload(oFile, sCompanyCode, sCountryCode);
        },

        _performUpload: async function(oFile, sCompanyCode, sCountryCode) {
            const oLocal = this.getView().getModel("local");
            oLocal.setProperty("/busy", true);

            try {
                // 1. Convert to Base64
                const toBase64 = file => new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.readAsDataURL(file);
                    reader.onload = () => resolve(reader.result.split(',')[1]); 
                    reader.onerror = error => reject(error);
                });

                const sBase64 = await toBase64(oFile);
                
                
                const sFileName = oFile.name.toLowerCase();
                
                // Unified Call Action (Backend handles dispatch based on format)
                const oModel = this.getView().getModel(); 
                const oOperation = oModel.bindContext("/UploadFile(...)");
                
                oOperation.setParameter("file", sBase64); 
                oOperation.setParameter("fileName", oFile.name);
                oOperation.setParameter("companyCode", sCompanyCode); 
                oOperation.setParameter("countryCode", sCountryCode); 

                await oOperation.execute();
                
                // Retrieve result (Job ID)
                const oResult = oOperation.getBoundContext().getObject();
                const sJobId = oResult && oResult.value ? oResult.value : null;

                MessageToast.show(this.getResourceBundle().getText("msgFileSyncing"));

                if (sJobId) {
                    MessageToast.show(this.getResourceBundle().getText("msgFileMonitorStart"));
                    this._startPolling(sJobId, oFile.name);
                }
                
                this.refreshTable();

            } catch (err) {
                if (err.message && err.message.includes("504")) {
                     MessageToast.show(this.getResourceBundle().getText("msgFileSyncTimeout"));
                     this.byId("DocumentTable").getBinding("rows").refresh();
                } else {
                     MessageBox.error(this.getResourceBundle().getText("errorUploadSync") + err.message);
                }
            }

            oLocal.setProperty("/busy", false);
        },



        /** NAVIGAZIONE AL DETTAGLIO (sap.m.Table) */
        onListItemPress: function (oEvent) {
            const oItem = oEvent.getParameter("listItem");
            const ctx = oItem.getBindingContext();
            
            if (!ctx) return;

            const sStatus = ctx.getProperty("statusBtp");
            // Check if ready (InvioOK means DONE/READY in this context)
            if (sStatus !== 'InvioOK') {
                MessageToast.show(this.getResourceBundle().getText("msgDocProcessing"));
                return;
            }

            const sId = ctx.getProperty("id");
            this.getRouter().navTo("Detail", { id: sId });
        },

        /** MOSTRA POPUP ERRORE BTP */
        onStatusErrorPress: function (oEvent) {
            const oCtx = oEvent.getSource().getBindingContext();
            if (!oCtx) return;

            const sErrorLog = oCtx.getProperty("sapErrorLog");
            const sFileName = oCtx.getProperty("fileName") || "Documento sconosciuto";

            var sTitle = this.getResourceBundle().getText("msgErrorDetailTitle", [sFileName]);
            if (sErrorLog) {
                sap.m.MessageBox.error(sErrorLog, {
                    title: sTitle
                });
            } else {
                sap.m.MessageBox.information(this.getResourceBundle().getText("msgNoErrorDetails"), {
                    title: sTitle
                });
            }
        },

        /** CANCELLAZIONE RECORD ODATA V4 (Multi-Delete) */
        onDelete: function () {
            const oTable = this.byId("DocumentTable");
            const aSelectedItems = oTable.getSelectedItems();

            if (aSelectedItems.length === 0) {
                MessageToast.show(this.getResourceBundle().getText("msgSelectDelete"));
                return;
            }

            const aDeletableContexts = [];
            let iSkipped = 0;

            // Analyze selection
            aSelectedItems.forEach(oItem => {
                const oCtx = oItem.getBindingContext();
                if (!oCtx) return;
                
                const sRegStatus = oCtx.getProperty("registrationStatus");
                // Block deletion if "Registered" (POSTED)
                if (sRegStatus === 'Registered') {
                    iSkipped++;
                } else {
                    aDeletableContexts.push(oCtx);
                }
            });

            if (aDeletableContexts.length === 0) {
                MessageBox.warning(this.getResourceBundle().getText("warningDeletePosted"));
                return;
            }

            // Construct confirmation message
            var oBundle = this.getResourceBundle();
            let sMessage = oBundle.getText("confirmDeleteMsg", [aDeletableContexts.length]);
            if (iSkipped > 0) {
                sMessage += oBundle.getText("confirmDeleteMsgSkipped", [iSkipped]);
            }

            MessageBox.confirm(sMessage, {
                title: oBundle.getText("confirmDeleteTitle"),
                actions: [MessageBox.Action.YES, MessageBox.Action.NO],
                onClose: async (sAction) => {
                    if (sAction === MessageBox.Action.YES) {
                        this.getView().getModel("local").setProperty("/busy", true);
                        try {
                            // Execute deletes in parallel
                            // OData V4 context.delete() returns a Promise
                            await Promise.all(aDeletableContexts.map(ctx => ctx.delete()));
                            
                            MessageToast.show(this.getResourceBundle().getText("msgDeleteSuccess"));
                            this.refreshTable();
                            oTable.removeSelections();
                            
                        } catch (err) {
                            MessageBox.error(this.getResourceBundle().getText("errorDelete") + (err.message || err));
                        } finally {
                             this.getView().getModel("local").setProperty("/busy", false);
                        }
                    }
                }
            });
        },

        /** AGGIORNA TABELLA */
        refreshTable: function () {
            const oTable = this.byId("DocumentTable");
            oTable?.getBinding("items")?.refresh();
        },

        _startPolling: function (sJobId, sFileName) {
            const oModel = this.getView().getModel();
            const iInterval = 5000; // 5 seconds
            
            // Clear existing if any (simplification: supports one active upload polling for now, or use map)
            if (this._pollingInterval) clearInterval(this._pollingInterval);

            this._pollingInterval = setInterval(async () => {
                try {
                    const oSyncOp = oModel.bindContext("/syncDataFromAI(...)");
                    oSyncOp.setParameter("id", sJobId);
                    oSyncOp.setParameter("fileName", sFileName);
                    
                    await oSyncOp.execute();
                    const oResult = oSyncOp.getBoundContext().getObject();
                    
                    if (oResult && oResult.status === "DONE") {
                        clearInterval(this._pollingInterval);
                        MessageToast.show(this.getResourceBundle().getText("msgProcessSuccess"));
                        this.refreshTable();
                    } else if (oResult && oResult.status === "FAILED") {
                        clearInterval(this._pollingInterval);
                        MessageBox.error(this.getResourceBundle().getText("errorProcessFailed"));
                        this.refreshTable();
                    } else {
                         // Still PENDING, continue polling
                         // Refresh table to show current status (e.g. if we map PENDING to 'Elaborazione')
                         this.refreshTable(); 
                    }
                } catch (err) {
                    console.error("Polling error", err);
                    // Don't stop necessarily, might be transient network error
                }
            }, iInterval);
        }

    });
});
