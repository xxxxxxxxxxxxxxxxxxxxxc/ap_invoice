sap.ui.define([], function () {
    "use strict";

    return {

        /**
         * Returns the translated text for the status
         * @param {string} sStatus Status code
         * @return {string} Translated status text
         */
        statoText: function (sStatus) {
            const resourceBundle = this.getView().getModel("i18n").getResourceBundle();
            switch (sStatus) {
                case "Da elaborare":
                case "PENDING":
                    return resourceBundle.getText("statusPending");
                case "InvioOK":
                case "DONE":
                    return resourceBundle.getText("statusDone");
                case "KO":
                case "FAILED":
                    return resourceBundle.getText("statusError");
                default:
                    return sStatus;
            }
        },

        /**
         * Returns the status state (color)
         * @param {string} sStatus Status code
         * @return {sap.ui.core.ValueState} Value state
         */
        colorStatusBtp: function (sStatus) {
            switch (sStatus) {
                case "Da elaborare":
                case "PENDING":
                    return "Warning"; // Orange
                case "InvioOK":
                case "DONE":
                    return "Success"; // Green
                case "KO":
                case "FAILED":
                    return "Error"; // Red
                default:
                    return "None";
            }
        },

        /**
         * Returns true if status is Error, false otherwise 
         * @param {string} sStatus Status code
         * @return {boolean} 
         */
        isErrorClickable: function (sStatus) {
             return sStatus === "KO" || sStatus === "FAILED";
        },

        /**
         * Returns the translated text for the upload type
         * @param {string} sType Upload type code
         * @return {string} Translated upload type
         */
        tipoCaricamentoValue: function (sType) {
             const resourceBundle = this.getView().getModel("i18n").getResourceBundle();
             if (sType === "A") return resourceBundle.getText("uploadTypeAutomatic");
             if (sType === "M") return resourceBundle.getText("uploadTypeManual");
             return sType;
        },

        registrationStatusText: function (sStatus) {
             const resourceBundle = this.getView().getModel("i18n").getResourceBundle();
             switch (sStatus) {
                 case "New": return resourceBundle.getText("regStatusNew");
                 case "Draft": return resourceBundle.getText("regStatusDraft");
                 case "Registered": return resourceBundle.getText("regStatusRegistered");
                 case "Error": return resourceBundle.getText("regStatusError");
                 default: return sStatus || resourceBundle.getText("regStatusNew");
             }
        },

        registrationStatusState: function (sStatus) {
             switch (sStatus) {
                 case "New": return "Information";
                 case "Draft": return "Warning"; // Orange
                 case "Registered": return "Success"; // Green
                 case "Error": return "Error"; // Red
                 default: return "None";
             }
        },

        yesNoText: function (sValue) {
             if (sValue === undefined || sValue === null || sValue === "") return "";
             const resourceBundle = this.getView().getModel("i18n").getResourceBundle();
             const str = String(sValue).trim().toUpperCase();
             if (str === "SI" || str === "YES" || str === "SÌ" || str === "Y" || str === "X" || str === "TRUE" || str === "1" || sValue === true) {
                 return resourceBundle.getText("yes");
             } else if (str === "NO" || str === "N" || str === "FALSE" || str === "0" || sValue === false) {
                 return resourceBundle.getText("no");
             }
             return sValue;
        }
    };
});
