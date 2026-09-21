sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/core/Fragment"
], (Controller, MessageToast, MessageBox, Fragment) => {

    return Controller.extend("configcountry.controller.Main", {
        onInit() {
        },
        onSelectionChange: function (oEvent) {
            var oItem = oEvent.getParameter("listItem");
            var oContext = oItem.getBindingContext();
            var sCode = oContext.getProperty("code");

            this.getOwnerComponent().getRouter().navTo("Detail", {
                countryCode: sCode
            });
        },

        onAddFieldType: function () {
            if (!this._oAddFieldTypeDialog) {
                this._oAddFieldTypeDialog = Fragment.load({
                    id: this.getView().getId(),
                    name: "configcountry.view.AddFieldTypeDialog",
                    controller: this
                }).then(function (oDialog) {
                    this.getView().addDependent(oDialog);
                    return oDialog;
                }.bind(this));
            }
            this._oAddFieldTypeDialog.then(function (oDialog) {
                this.byId("inNewFieldTypeCode").setValue("");
                this.byId("inNewFieldTypeName").setValue("");
                this.byId("inNewFieldTypeDesc").setValue("");
                oDialog.open();
            }.bind(this));
        },

        onConfirmAddFieldType: function () {
            const sCode = this.byId("inNewFieldTypeCode").getValue().trim();
            const sName = this.byId("inNewFieldTypeName").getValue().trim();
            const sDesc = this.byId("inNewFieldTypeDesc").getValue().trim();

            if (!sCode || !sName) {
                MessageBox.error("Code and Name are mandatory.");
                return;
            }

            const oTable = this.byId("fieldTypesTable");
            const oListBinding = oTable.getBinding("items");

            oListBinding.create({
                code: sCode,
                name: sName,
                description: sDesc,
                isDefault: false
            });

            this.onCancelAddFieldType();
            MessageToast.show("Field Type added to the list. Remember to save changes.");
        },

        onCancelAddFieldType: function () {
            this._oAddFieldTypeDialog.then(function (oDialog) {
                oDialog.close();
            });
        },

        onSaveFieldTypes: function () {
            const oModel = this.getView().getModel();
            oModel.submitBatch("$auto").then(() => {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("msgSaved"));
            }).catch((err) => {
                MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("msgError"));
                console.error(err);
            });
        },

        onCancelFieldTypes: function () {
            const oModel = this.getView().getModel();
            oModel.resetChanges("$auto");
        },

        onDeleteFieldType: function (oEvent) {
            const oItem = oEvent.getParameter("listItem");
            const oContext = oItem.getBindingContext();
            const bIsDefault = oContext.getProperty("isDefault");

            if (bIsDefault) {
                MessageToast.show("Default field types cannot be deleted");
                return;
            }

            MessageBox.confirm("Are you sure you want to delete this field type?", {
                onClose: (sAction) => {
                    if (sAction === MessageBox.Action.OK) {
                        oContext.delete().then(() => {
                            MessageToast.show("Field type deleted");
                        }).catch((err) => {
                            MessageToast.show("Error deleting field type");
                            console.error(err);
                        });
                    }
                }
            });
        },

        onAddCountry: function () {
            // Simple dialog to create a new country
            // In a real app, use a Fragment. Here using simple JS for speed.
            var that = this;
            var oDialog = new sap.m.Dialog({
                title: "New Country",
                type: "Message",
                content: [
                    new sap.m.Label({ text: "Country Code (2 chars)", labelFor: "code" }),
                    new sap.m.Input("code", { maxLength: 2, width: "100%" }),
                    new sap.m.Label({ text: "Country Name", labelFor: "name" }),
                    new sap.m.Input("name", { width: "100%" })
                ],
                beginButton: new sap.m.Button({
                    type: "Emphasized",
                    text: "Create",
                    press: function () {
                        var sCode = sap.ui.getCore().byId("code").getValue();
                        var sName = sap.ui.getCore().byId("name").getValue();

                        if (!sCode || !sName) {
                            MessageToast.show("Please fill all fields");
                            return;
                        }

                        // Create entry via OData
                        var oModel = that.getView().getModel();
                        const oListBinding = oModel.bindList("/Countries");

                        const oContext = oListBinding.create({
                            code: sCode,
                            name: sName,
                            active: true
                        });

                        oContext.created().then(() => {
                            MessageToast.show("Country created!");

                            that.getOwnerComponent().getRouter().navTo("Detail", {
                                countryCode: sCode
                            });
                        }).catch((err) => {
                            MessageToast.show("Error creating country");
                            console.error(err);
                        });
                        /*
                        var oModel = that.getView().getModel();
                        oModel.create("/Countries", {
                            code: sCode,
                            name: sName,
                            active: true
                        }, {
                            success: function () {
                                MessageToast.show("Country created");
                                oDialog.close();
                                // Navigate to detail
                                that.getOwnerComponent().getRouter().navTo("Detail", {
                                    countryCode: sCode
                                });
                            },
                            error: function () {
                                MessageToast.show("Error creating country");
                            }
                        });
                        */
                    }
                }),
                endButton: new sap.m.Button({
                    text: "Cancel",
                    press: function () {
                        oDialog.close();
                    }
                }),
                afterClose: function () {
                    oDialog.destroy();
                }
            });

            oDialog.open();
        }
    });
});