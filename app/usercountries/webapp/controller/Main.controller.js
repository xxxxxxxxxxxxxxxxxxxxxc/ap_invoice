sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/core/Fragment",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "usercountries/model/formatter"
], function (Controller, JSONModel, Fragment, Filter, FilterOperator, MessageToast, MessageBox, formatter) {
    "use strict";

    return Controller.extend("usercountries.controller.Main", {
        formatter: formatter,

        onInit: function () {
            var oLocalModel = new JSONModel({
                busy: false
            });
            this.getView().setModel(oLocalModel, "local");
        },

        onSearch: function (oEvent) {
            var sQuery = oEvent.getParameter("query");
            var oTable = this.byId("table");
            var oBinding = oTable.getBinding("items");
            if (oBinding) {
                var aFilters = [];
                if (sQuery) {
                    aFilters.push(new Filter("email", FilterOperator.Contains, sQuery));
                }
                oBinding.filter(aFilters);
            }
        },

        onAdd: function () {
            var oView = this.getView();
            if (!this._oDialog) {
                Fragment.load({
                    id: oView.getId(),
                    name: "usercountries.view.AddDialog",
                    controller: this
                }).then(function (oDialog) {
                    this._oDialog = oDialog;
                    oView.addDependent(this._oDialog);
                    this._oDialog.open();
                }.bind(this));
            } else {
                this._oDialog.open();
            }
        },

        onCancel: function () {
            if (this._oDialog) {
                this.byId("inputEmail").setValue("");
                this._oDialog.close();
            }
        },

        onSave: function () {
            var oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            var sEmail = this.byId("inputEmail").getValue();
            var sCountryCode = this.byId("selectCountry").getSelectedKey();

            if (!sEmail) {
                MessageBox.error(oResourceBundle.getText("invalidEmail"));
                return;
            }

            var oTable = this.byId("table");
            var oBinding = oTable.getBinding("items");
            
            this.getView().getModel("local").setProperty("/busy", true);

            var oNewContext = oBinding.create({
                email: sEmail,
                country_code: sCountryCode
            });

            oNewContext.created().then(function () {
                this.getView().getModel("local").setProperty("/busy", false);
                MessageToast.show(oResourceBundle.getText("saveSuccess"));
                this.byId("inputEmail").setValue("");
                if (this._oDialog) {
                    this._oDialog.close();
                }
            }.bind(this), function (oError) {
                this.getView().getModel("local").setProperty("/busy", false);
                MessageBox.error(oError.message);
            }.bind(this));
        },

        onDelete: function () {
            var oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
            var oTable = this.byId("table");
            var aSelectedItems = oTable.getSelectedItems();

            if (aSelectedItems.length === 0) {
                MessageToast.show(oResourceBundle.getText("selectItemToDelete"));
                return;
            }

            var aContexts = [];
            aSelectedItems.forEach(function (oItem) {
                var oCtx = oItem.getBindingContext();
                if (oCtx) {
                    aContexts.push(oCtx);
                }
            });

            var sMessage = oResourceBundle.getText("confirmDelete", [aContexts.length]);

            MessageBox.confirm(sMessage, {
                title: oResourceBundle.getText("confirmDeleteTitle"),
                actions: [MessageBox.Action.YES, MessageBox.Action.NO],
                onClose: function (sAction) {
                    if (sAction === MessageBox.Action.YES) {
                        this.getView().getModel("local").setProperty("/busy", true);
                        var aPromises = aContexts.map(function (oContext) {
                            return oContext.delete();
                        });

                        Promise.all(aPromises).then(function () {
                            this.getView().getModel("local").setProperty("/busy", false);
                            MessageToast.show(oResourceBundle.getText("deleteSuccess"));
                            oTable.removeSelections();
                        }.bind(this)).catch(function (oError) {
                            this.getView().getModel("local").setProperty("/busy", false);
                            MessageBox.error(oError.message);
                        }.bind(this));
                    }
                }.bind(this)
            });
        }
    });
});
