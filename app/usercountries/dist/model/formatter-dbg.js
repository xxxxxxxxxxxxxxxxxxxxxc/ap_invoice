sap.ui.define([], function () {
    "use strict";

    return {
        formatEmail: function (sEmail) {
            return sEmail ? sEmail.toLowerCase() : "";
        }
    };
});
