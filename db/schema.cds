namespace db;

using {managed} from '@sap/cds/common';

entity DocumentStatusBtp : managed {

    key id                 : String;
        status             : String                @title: 'Stato Estrazione'     @Common.Label: 'Stato Estrazione';
        fileName           : String                @title: 'Nome file'            @Common.Label: 'Nome file';
        documentType       : String                @title: 'Tipo doc.'            @Common.Label: 'Tipo doc.';
        clientId           : String;
        countryCode        : String(2);
        companyCode        : String(4);
        statusBtp          : String                @title: 'Stato Elaborazione'   @Common.Label: 'Stato Elaborazione';
        registrationStatus : String default 'New'  @title: 'Stato Registrazione'  @Common.Label: 'Stato Registrazione';
        scenario           : String                @title: 'Scenario'             @Common.Label: 'Scenario';
        EbelnGen           : String                @title: 'Doc. Generato'        @Common.Label: 'Doc. Generato';
        tipoCaricamento    : String                @title: 'Tipo Caricamento'     @Common.Label: 'Tipo Caricamento';
        mailFornitore      : String                @title: 'Mail fornitore'       @Common.Label: 'Mail fornitore';
        fornitore          : String                @title: 'Fornitore'            @Common.Label: 'Fornitore';
        ordine             : String                @title: 'Ordine'               @Common.Label: 'Ordine';
        invoiceNumber      : String                @title: 'Numero Fattura'       @Common.Label: 'Numero Fattura';
        fattura            : String                @title: 'Fattura'              @Common.Label: 'Fattura';
        oggettoMail        : String                @title: 'Oggetto Mail'         @Common.Label: 'Oggetto Mail';
        extractedData      : LargeString           @title: 'Dati Estratti JSON'   @Common.Label: 'Dati Estratti JSON';
        sapErrorLog        : LargeString           @title: 'Log Errori SAP'       @Common.Label: 'Log Errori SAP';
        cmisId             : String                @title: 'DMS Object ID'        @Common.Label: 'DMS Object ID';
        content            : LargeString           @title: 'File Content'         @Common.Label: 'File Content';
        pdfContent         : LargeString           @title: 'PDF Content'          @Common.Label: 'PDF Content';
        agentLog           : LargeString           @title: 'Log Agente AI'        @Common.Label: 'Log Agente AI';
        inputTokens        : Integer               @title: 'Input Tokens'         @Common.Label: 'Input Tokens';
        outputTokens       : Integer               @title: 'Output Tokens'        @Common.Label: 'Output Tokens';

}

// Country configuration entities
entity Countries : managed {
    key code              : String(2)             @title: 'Country Code'          @Common.Label: 'Country Code';
        name              : String                @title: 'Country Name'          @Common.Label: 'Country Name';
        description       : String                @title: 'Description'           @Common.Label: 'Description';
        aiModel           : String                @title: 'AI Model'              @Common.Label: 'AI Model';
        aiTemperature     : Decimal(3,2) default 0.0 @title: 'AI Temperature'        @Common.Label: 'AI Temperature';
        active            : Boolean default true  @title: 'Active'                @Common.Label: 'Active';
        xmlReferenceTag   : String                @title: 'XML Reference Tag'     @Common.Label: 'XML Reference Tag';
        xmlPoReferenceTag : String                @title: 'XML PO Reference Tag'  @Common.Label: 'XML PO Reference Tag';
        xmlVendorTag      : String                @title: 'XML Vendor Tag'        @Common.Label: 'XML Vendor Tag';
        xmlInvoiceNumberTag : String             @title: 'XML Invoice Number Tag' @Common.Label: 'XML Invoice Number Tag';
        xmlCompanyCodeTag   : String             @title: 'XML Company Code Tag'  @Common.Label: 'XML Company Code Tag';
        systemPrompt      : LargeString           @title: 'System Prompt'         @Common.Label: 'System Prompt';
        to_FieldConfig    : Composition of many CountryFieldConfig
                                on to_FieldConfig.country = $self;
        to_CompanyCodes   : Composition of many CompanyCodes
                                on to_CompanyCodes.country = $self;
}

entity CompanyCodes : managed {
    key id          : UUID;
        code        : String(4)  @title: 'Company Code'  @Common.Label: 'Company Code';
        description : String     @title: 'Description'   @Common.Label: 'Description';
        country     : Association to Countries;
}

// Master list of Document AI invoice schema fields
entity DocumentAIFields : managed {
    key fieldName   : String                @title: 'Field Name'   @Common.Label: 'Field Name';
        fieldLabel  : String                @title: 'Field Label'  @Common.Label: 'Field Label';
    key fieldType   : String                @title: 'Field Type'   @Common.Label: 'Field Type'; // header or lineItem
    key sourceType  : String default 'DOX'  @title: 'Source Type'  @Common.Label: 'Source Type'; // DOX or XML
        description : String                @title: 'Description'  @Common.Label: 'Description';
}

// Master list of available field types (header, lineItem, withholdingtax, etc.)
entity FieldTypes : managed {
    key code        : String  @title: 'Code'        @Common.Label: 'Code'; // header, lineItem, etc.
        name        : String  @title: 'Name'        @Common.Label: 'Name';
        description : String  @title: 'Description' @Common.Label: 'Description';
        isDefault   : Boolean @title: 'Is Default'  @Common.Label: 'Is Default'; // header / lineItem cannot be deleted
}

// Master list of OData service fields for invoice registration
entity ODataFields : managed {
    key id          : UUID;
        fieldName   : String  @title: 'Field Name'   @Common.Label: 'Field Name';
        entityName  : String  @title: 'Entity Name'  @Common.Label: 'Entity Name';
        fieldLabel  : String  @title: 'Field Label'  @Common.Label: 'Field Label';
        fieldType   : String  @title: 'Field Type'   @Common.Label: 'Field Type'; // header or item
        dataType    : String  @title: 'Data Type'    @Common.Label: 'Data Type';
        description : String  @title: 'Description'  @Common.Label: 'Description';
}

// Country-specific field configuration
entity CountryFieldConfig : managed {
    key id                     : UUID;
        country                : Association to Countries;
        documentAIField        : Association to DocumentAIFields;
        mandatory              : Boolean default false  @title: 'Mandatory'            @Common.Label: 'Mandatory';
        visible                : Boolean default true   @title: 'Visible'              @Common.Label: 'Visible';
        editable               : Boolean default true   @title: 'Editable'             @Common.Label: 'Editable';
        active                 : Boolean default true   @title: 'Active'               @Common.Label: 'Active';
        displayOrder           : Integer                @title: 'Display Order'        @Common.Label: 'Display Order';
        customLabel            : String                 @title: 'Custom Label'         @Common.Label: 'Custom Label';
        scenario               : String default 'MM'    @title: 'Scenario'             @Common.Label: 'Scenario'; // MM or FI
        searchHelpFunction     : Association to ConversionFunctions;
        searchHelpInputMapping : LargeString            @title: 'Search Help Mapping'  @Common.Label: 'Search Help Mapping';
        toBeControlled         : Boolean default false  @title: 'To Be Controlled'     @Common.Label: 'To Be Controlled';
}

// Conversion functions catalogue
entity ConversionFunctions : managed {
    key id          : UUID;
        name        : String                @title: 'Function Name'     @Common.Label: 'Function Name';
        description : String                @title: 'Description'       @Common.Label: 'Description';
        serviceUrl  : String                @title: 'Service URL'       @Common.Label: 'Service URL';
        inputParams : String                @title: 'Input Parameters'  @Common.Label: 'Input Parameters';
        outputField : String                @title: 'Output Field'      @Common.Label: 'Output Field';
        destination : String                @title: 'Destination'       @Common.Label: 'Destination';
        method      : String default 'GET'  @title: 'Method'            @Common.Label: 'Method'; // GET, POST, etc.
}

// Field mapping between Document AI and OData
entity FieldMappings : managed {
    key id                 : UUID;
        country            : Association to Countries;
        documentAIField    : Association to DocumentAIFields;
        odataField         : Association to ODataFields;
        steps              : Composition of many MappingSteps
                                 on steps.parent = $self;
        active             : Boolean default true   @title: 'Active'                @Common.Label: 'Active';
        scenario           : String default 'MM'    @title: 'Scenario'              @Common.Label: 'Scenario'; // MM or FI
        groupId            : Integer                @title: 'Group ID'              @Common.Label: 'Group ID'; // Optional explicit grouping 1-based
        aggregationGroupBy : Boolean default false  @title: 'Aggregation Group By'  @Common.Label: 'Aggregation Group By';
        aggregationSum     : Boolean default false  @title: 'Aggregation Sum'       @Common.Label: 'Aggregation Sum';
}

entity MappingSteps : managed {
    key id                 : UUID;
        parent             : Association to FieldMappings;
        stepOrder          : Integer;
        conversionFunction : Association to ConversionFunctions;
        functionParameters : LargeString  @title: 'Function Parameters'  @Common.Label: 'Function Parameters';
}

entity ConfigLocks : managed {
    key countryCode : String(2);
        lockedBy : String;
        lockedAt : DateTime;
}

entity UserCountries : managed {
    key email   : String @title: 'User Email' @Common.Label: 'User Email';
    key country : Association to Countries;
}

