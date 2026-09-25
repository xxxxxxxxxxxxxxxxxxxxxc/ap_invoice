sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "knowledgebase/model/formatter"
], function (Controller, JSONModel, Filter, FilterOperator, MessageToast, MessageBox, formatter) {
    "use strict";

    // documents still being chunked / embedded: the list is refreshed until none is left
    var PENDING_STATUSES = ["Uploaded", "Processing"];
    var POLLING_INTERVAL_MS = 4000;

    return Controller.extend("knowledgebase.controller.Main", {
        formatter: formatter,

        onInit: function () {
            this.getView().setModel(new JSONModel({
                busy: false,
                hasSelection: false
            }), "local");
        },

        onExit: function () {
            this._stopPolling();
        },

        _getText: function (sKey, aArgs) {
            return this.getView().getModel("i18n").getResourceBundle().getText(sKey, aArgs);
        },

        _getBinding: function () {
            return this.byId("table").getBinding("items");
        },

        onSearch: function (oEvent) {
            var sQuery = oEvent.getParameter("query");
            var aFilters = sQuery
                ? [new Filter({ path: "fileName", operator: FilterOperator.Contains, value1: sQuery, caseSensitive: false })]
                : [];
            this._getBinding().filter(aFilters);
        },

        onRefresh: function () {
            this._getBinding().refresh();
        },

        onSelectionChange: function () {
            this.getView().getModel("local").setProperty("/hasSelection", !!this.byId("table").getSelectedItem());
        },

        onDataReceived: function () {
            var bPending = this._getBinding().getContexts().some(function (oContext) {
                return PENDING_STATUSES.indexOf(oContext.getProperty("status")) >= 0;
            });
            if (bPending) {
                this._startPolling();
            } else {
                this._stopPolling();
            }
        },

        _startPolling: function () {
            if (this._iPollingTimer) {
                return;
            }
            this._iPollingTimer = setInterval(function () {
                var oBinding = this._getBinding();
                if (!oBinding.hasPendingChanges()) {
                    oBinding.refresh();
                }
            }.bind(this), POLLING_INTERVAL_MS);
        },

        _stopPolling: function () {
            if (this._iPollingTimer) {
                clearInterval(this._iPollingTimer);
                this._iPollingTimer = null;
            }
        },

        onTypeMismatch: function () {
            MessageBox.error(this._getText("msgTypeMismatch"));
        },

        onFileSelected: function (oEvent) {
            var oFile = oEvent.getParameter("files") && oEvent.getParameter("files")[0];
            if (!oFile) {
                return;
            }
            this._upload(oFile).finally(function () {
                this.byId("fileUploader").clear();
            }.bind(this));
        },

        _readAsBase64: function (oFile) {
            return new Promise(function (resolve, reject) {
                var oReader = new FileReader();
                oReader.onload = function () {
                    resolve(oReader.result.split(",")[1]);
                };
                oReader.onerror = reject;
                oReader.readAsDataURL(oFile);
            });
        },

        _upload: async function (oFile) {
            var oLocal = this.getView().getModel("local");
            oLocal.setProperty("/busy", true);
            try {
                var sBase64 = await this._readAsBase64(oFile);
                var oOperation = this.getView().getModel().bindContext("/uploadKnowledgeDocument(...)");
                oOperation.setParameter("file", sBase64);
                oOperation.setParameter("fileName", oFile.name);
                oOperation.setParameter("mimeType", oFile.type || null);
                await oOperation.execute();

                MessageToast.show(this._getText("msgUploaded", [oFile.name]));
                this.onRefresh();
            } catch (oError) {
                MessageBox.error(this._getText("msgUploadError") + "\n" + oError.message);
            } finally {
                oLocal.setProperty("/busy", false);
            }
        },

        onReprocess: async function () {
            var oItem = this.byId("table").getSelectedItem();
            if (!oItem) {
                return;
            }
            var oContext = oItem.getBindingContext();
            try {
                var oOperation = this.getView().getModel().bindContext("/reprocessKnowledgeDocument(...)");
                oOperation.setParameter("id", oContext.getProperty("ID"));
                await oOperation.execute();
                MessageToast.show(this._getText("msgReprocessStarted"));
                this.onRefresh();
            } catch (oError) {
                MessageBox.error(oError.message);
            }
        },

        onDelete: function () {
            var oItem = this.byId("table").getSelectedItem();
            if (!oItem) {
                return;
            }
            var oContext = oItem.getBindingContext();
            MessageBox.confirm(this._getText("msgDeleteConfirm", [oContext.getProperty("fileName")]), {
                onClose: function (sAction) {
                    if (sAction !== MessageBox.Action.OK) {
                        return;
                    }
                    oContext.delete().then(function () {
                        MessageToast.show(this._getText("msgDeleted"));
                        this.getView().getModel("local").setProperty("/hasSelection", false);
                    }.bind(this)).catch(function (oError) {
                        MessageBox.error(oError.message);
                    });
                }.bind(this)
            });
        }
    });
});
