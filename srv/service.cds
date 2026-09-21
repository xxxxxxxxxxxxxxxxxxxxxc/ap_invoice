using {db} from '../db/schema';

@path: '/service/CatalogService'
service CatalogService {
    type ChatbotReply {
        reply     : LargeString;
        timestamp : String;
        // conversation the reply belongs to: the client sends it back on the next
        // message so the assistant keeps the context of the chat
        sessionId : String;
    }

    type JobsResult {
        status       : String;
        id           : String;
        fileName     : String;
        documentType : String;
        created      : String;
        finished     : String;
        clientId     : String;
    }

    entity DocumentStatusBtp   as projection on db.DocumentStatusBtp;

    /* Sezione annotazioni */
    annotate DocumentStatusBtp with @(UI.LineItem: [
        {
            $Type: 'UI.DataField',
            Label: 'Nome file',
            Value: fileName,
        },
        {
            $Type: 'UI.DataField',
            Label: 'Tipo',
            Value: tipoCaricamento,
        },
        {
            $Type: 'UI.DataField',
            Label: 'Company Code',
            Value: companyCode,
        },
        {
            $Type: 'UI.DataField',
            Label: 'Scenario',
            Value: scenario,
        },
        {
            $Type: 'UI.DataField',
            Label: 'Data creazione',
            Value: createdAt,
        },
        {
            $Type: 'UI.DataField',
            Label: 'Data ultima modifica',
            Value: modifiedAt,
        },
        {
            $Type                : 'UI.DataField',
            Label                : 'Doc. Generato',
            Value                : EbelnGen,
            ![@HTML5.CssDefaults]: {
                $Type: 'HTML5.CssDefaultsType',
                width: '10rem',
            }
        },
        {
            $Type: 'UI.DataField',
            Label: 'Fornitore',
            Value: fornitore,
        },
        {
            $Type                : 'UI.DataField',
            Label                : 'Ordine',
            Value                : ordine,
            ![@HTML5.CssDefaults]: {
                $Type: 'HTML5.CssDefaultsType',
                width: '8rem',
            }
        },
        {
            $Type: 'UI.DataField',
            Label: 'Numero Fattura',
            Value: invoiceNumber,
        }
    ]);

    annotate DocumentStatusBtp with @(UI: {SelectionFields: [
        fileName,
        modifiedAt,
        tipoCaricamento,
        statusBtp,
        fornitore,
        ordine,
        invoiceNumber,
        companyCode,
        scenario
    ]});

    annotate DocumentStatusBtp with {
        id         @UI.Hidden      : true;
        createdBy  @UI.Hidden      : true;
        modifiedBy @UI.Hidden      : true;
        clientId   @UI.Hidden      : true;
        id         @UI.HiddenFilter: true;
        createdBy  @UI.HiddenFilter: true;
        modifiedBy @UI.HiddenFilter: true;
        clientId   @UI.HiddenFilter: true;
    };

    annotate DocumentStatusBtp with @(
        UI.FieldGroup #GeneratedGroup1: {
            $Type: 'UI.FieldGroupType',
            Data : [
                {
                    $Type: 'UI.DataField',
                    Label: 'Nome file',
                    Value: fileName,
                },
                {
                    $Type: 'UI.DataField',
                    Label: 'Tipo',
                    Value: tipoCaricamento,
                },
                {
                    $Type: 'UI.DataField',
                    Label: 'Company Code',
                    Value: companyCode,
                },
                {
                    $Type: 'UI.DataField',
                    Label: 'Scenario',
                    Value: scenario,
                },
                {
                    $Type: 'UI.DataField',
                    Label: 'Data creazione',
                    Value: createdAt,
                },
                {
                    $Type: 'UI.DataField',
                    Label: 'Data ultima modifica',
                    Value: modifiedAt,
                },
                {
                    $Type: 'UI.DataField',
                    Label: 'Numero Fattura',
                    Value: invoiceNumber,
                }
            ],
        },
        UI.Facets                     : [{
            $Type : 'UI.ReferenceFacet',
            ID    : 'GeneratedFacet1',
            Label : 'General Information',
            Target: '@UI.FieldGroup#GeneratedGroup1',
        }, ]
    );

    annotate DocumentStatusBtp with {
        tipoCaricamento @(Common: {
            ValueListWithFixedValues: true,
            ValueList               : {
                $Type         : 'Common.ValueListType',
                Label         : 'Periodo',
                CollectionPath: 'TipiCaricamento',
                Parameters    : [{
                    $Type            : 'Common.ValueListParameterInOut',
                    LocalDataProperty: tipoCaricamento,
                    ValueListProperty: 'TIPO'
                }]
            }
        });
        statusBtp       @(Common: {
            ValueListWithFixedValues: true,
            ValueList               : {
                $Type         : 'Common.ValueListType',
                Label         : 'Stato Elaborazione',
                CollectionPath: 'StatiElaborazione',
                Parameters    : [{
                    $Type            : 'Common.ValueListParameterInOut',
                    LocalDataProperty: statusBtp,
                    ValueListProperty: 'stato'
                }]
            }
        });
    }

    entity TipiCaricamento {
        key ![TIPO]      : String;
            ![DESC_TIPO] : String;
    }

    annotate TipiCaricamento with {
        TIPO @Common: {Text: DESC_TIPO}
    }

    entity StatiElaborazione {
        key ![stato]      : String;
            ![desc_stato] : String;
    }

    annotate StatiElaborazione with {
        stato @Common: {Text: desc_stato}
    }

    function getJobs(fileName: String null)                                                                                                                   returns array of JobsResult;
    function getJobById(id: String)                                                                                                                           returns {};
    function getJobByIdV2(id: String)                                                                                                                         returns LargeString;
    function getFileByJobId(id: String)                                                                                                                       returns {};
    action   syncDataFromAI(id: String, fileName: String)                                                                                                     returns JobsResult;
    action   UploadFile(file: LargeBinary, fileName: String, companyCode: String, countryCode: String, tipoCaricamento: String)                               returns String;

    // Function to get country-specific field configuration
    function getCountryFieldConfig(countryCode: String)                                                                                                       returns {};
    function getUserAllowedCountries()                                                                                                                        returns array of Countries;

    entity Countries           as projection on db.Countries;
    entity CompanyCodes        as projection on db.CompanyCodes;

    entity DocumentAIFields    as projection on db.DocumentAIFields;
    entity ODataFields         as projection on db.ODataFields;
    entity CountryFieldConfig  as projection on db.CountryFieldConfig;
    entity FieldMappings       as projection on db.FieldMappings;

    entity ConversionFunctions as projection on db.ConversionFunctions;
    entity FieldTypes          as projection on db.FieldTypes;
    entity ConfigLocks         as projection on db.ConfigLocks;
    entity UserCountries       as projection on db.UserCountries;

    // Actions for dynamic field loading

    action   loadDocumentAISchema(countryCode: String, schemaJson: LargeString)                                                                               returns {
        message : String;
        count   : Integer;
    };


    action   loadODataEDMX(countryCode: String, edmxContent: LargeString)                                                                                     returns {
        message : String;
        count   : Integer;
    };


    action   saveConfiguration(countryCode: String, configuration: LargeString, xmlReferenceTag: String, xmlPoReferenceTag: String, xmlVendorTag: String, xmlInvoiceNumberTag: String, xmlCompanyCodeTag: String, aiModel: String, aiTemperature: Decimal(3,2)) returns String;
    action   detectFieldsFromXml(xmlContent: LargeString, referenceTag: String)                                                                               returns String;

    action   acquireLock(countryCode: String)                                                                                                                 returns String;
    action   releaseLock(countryCode: String)                                                                                                                 returns String;

    action   registerInvoice(id: String, countryCode: String, headerData: LargeString, itemsData: LargeString, Simulation: Boolean, skipConversions: Boolean) returns String;

    // Action to simulate mapping and return the generated payload (preview)
    action   simulateMapping(id: String, scenario: String, headerData: LargeString, itemsData: LargeString, skipConversions: Boolean)                         returns LargeString;

    // Action to execute Search Help dynamically
    action   executeSearchHelp(functionId: String, filters: LargeString)                                                                                      returns LargeString;

    // Chatbot: sends a user message and returns the assistant reply.
    // sessionId and locale are optional: without a sessionId a new conversation is started.
    // documentId is the invoice open in the UI, so the assistant knows what "this invoice" is.
    action   chatbotMessage(message: String, sessionId: String null, locale: String null, documentId: String null)                                            returns ChatbotReply;
}

annotate CatalogService with @requires: ['authenticated-user'];

// Annotations for Countries
annotate CatalogService.Countries with @(UI.LineItem: [
    {
        $Type: 'UI.DataField',
        Label: 'Country Code',
        Value: code,
    },
    {
        $Type: 'UI.DataField',
        Label: 'Country Name',
        Value: name,
    },
    {
        $Type: 'UI.DataField',
        Label: 'Description',
        Value: description,
    },
    {
        $Type: 'UI.DataField',
        Label: 'Active',
        Value: active,
    }
]);

annotate CatalogService.Countries with @(
    UI.FieldGroup #GeneralInfo: {
        $Type: 'UI.FieldGroupType',
        Data : [
            {
                $Type: 'UI.DataField',
                Label: 'Country Code',
                Value: code,
            },
            {
                $Type: 'UI.DataField',
                Label: 'Country Name',
                Value: name,
            },
            {
                $Type: 'UI.DataField',
                Label: 'Description',
                Value: description,
            },
            {
                $Type: 'UI.DataField',
                Label: 'Active',
                Value: active,
            }
        ],
    },
    UI.Facets                 : [{
        $Type : 'UI.ReferenceFacet',
        ID    : 'GeneralInfoFacet',
        Label : 'General Information',
        Target: '@UI.FieldGroup#GeneralInfo',
    }]
);

// Annotations for CountryFieldConfig
annotate CatalogService.CountryFieldConfig with @(UI.LineItem: [
    {
        $Type: 'UI.DataField',
        Label: 'Document AI Field',
        Value: documentAIField.fieldLabel,
    },
    {
        $Type: 'UI.DataField',
        Label: 'Field Type',
        Value: documentAIField.fieldType,
    },
    {
        $Type: 'UI.DataField',
        Label: 'Mandatory',
        Value: mandatory,
    },
    {
        $Type: 'UI.DataField',
        Label: 'Visible',
        Value: visible,
    },
    {
        $Type: 'UI.DataField',
        Label: 'Display Order',
        Value: displayOrder,
    }
]);

// Annotations for FieldMappings
annotate CatalogService.FieldMappings with @(UI.LineItem: [
    {
        $Type: 'UI.DataField',
        Label: 'Document AI Field',
        Value: documentAIField.fieldLabel,
    },
    {
        $Type: 'UI.DataField',
        Label: 'OData Field',
        Value: odataField.fieldLabel,
    },
    {
        $Type: 'UI.DataField',
        Label: 'Conversion Function',
        Value: conversionFunction.name,
    },
    {
        $Type: 'UI.DataField',
        Label: 'Transformation Rule',
        Value: transformationRule,
    },
    {
        $Type: 'UI.DataField',
        Label: 'Group ID',
        Value: groupId,
    },
    {
        $Type: 'UI.DataField',
        Label: 'Group By',
        Value: aggregationGroupBy,
    },
    {
        $Type: 'UI.DataField',
        Label: 'Sum',
        Value: aggregationSum,
    },
    {
        $Type: 'UI.DataField',
        Label: 'Active',
        Value: active,
    }
]);

// Annotations for ConversionFunctions
annotate CatalogService.ConversionFunctions with @(
    UI.HeaderInfo      : {
        TypeName      : 'Conversion Function',
        TypeNamePlural: 'Conversion Functions',
        Title         : {Value: name},
        Description   : {Value: description}
    },
    UI.LineItem        : [
        {
            $Type: 'UI.DataField',
            Label: 'Function Name',
            Value: name
        },
        {
            $Type: 'UI.DataField',
            Label: 'Description',
            Value: description
        },
        {
            $Type: 'UI.DataField',
            Label: 'Service URL',
            Value: serviceUrl
        },
        {
            $Type: 'UI.DataField',
            Label: 'Destination',
            Value: destination
        }
    ],
    UI.FieldGroup #Main: {Data: [
        {
            $Type: 'UI.DataField',
            Label: 'Function Name',
            Value: name
        },
        {
            $Type: 'UI.DataField',
            Label: 'Description',
            Value: description
        },
        {
            $Type: 'UI.DataField',
            Label: 'Service URL',
            Value: serviceUrl
        },
        {
            $Type: 'UI.DataField',
            Label: 'Input Parameters',
            Value: inputParams
        },
        {
            $Type: 'UI.DataField',
            Label: 'Output Field',
            Value: outputField
        },
        {
            $Type: 'UI.DataField',
            Label: 'Destination',
            Value: destination
        }
    ]},
    UI.Facets          : [{
        $Type : 'UI.ReferenceFacet',
        ID    : 'MainFacet',
        Label : 'General Information',
        Target: '@UI.FieldGroup#Main'
    }]
);

// Value help for DocumentAIField selection
annotate CatalogService.CountryFieldConfig with {
    documentAIField @(Common: {ValueList: {
        $Type         : 'Common.ValueListType',
        Label         : 'Document AI Fields',
        CollectionPath: 'DocumentAIFields',
        Parameters    : [
            {
                $Type            : 'Common.ValueListParameterInOut',
                LocalDataProperty: documentAIField_fieldName,
                ValueListProperty: 'fieldName'
            },
            {
                $Type            : 'Common.ValueListParameterDisplayOnly',
                ValueListProperty: 'fieldLabel'
            },
            {
                $Type            : 'Common.ValueListParameterDisplayOnly',
                ValueListProperty: 'fieldType'
            }
        ]
    }});
}

// Value help for ODataField selection in mappings
annotate CatalogService.FieldMappings with {
    documentAIField @(Common: {ValueList: {
        $Type         : 'Common.ValueListType',
        Label         : 'Document AI Fields',
        CollectionPath: 'DocumentAIFields',
        Parameters    : [
            {
                $Type            : 'Common.ValueListParameterInOut',
                LocalDataProperty: documentAIField_fieldName,
                ValueListProperty: 'fieldName'
            },
            {
                $Type            : 'Common.ValueListParameterDisplayOnly',
                ValueListProperty: 'fieldLabel'
            }
        ]
    }});
    odataField      @(Common: {ValueList: {
        $Type         : 'Common.ValueListType',
        Label         : 'OData Fields',
        CollectionPath: 'ODataFields',
        Parameters    : [
            {
                $Type            : 'Common.ValueListParameterInOut',
                LocalDataProperty: odataField_fieldName,
                ValueListProperty: 'fieldName'
            },
            {
                $Type            : 'Common.ValueListParameterDisplayOnly',
                ValueListProperty: 'fieldLabel'
            },
            {
                $Type            : 'Common.ValueListParameterDisplayOnly',
                ValueListProperty: 'dataType'
            }
        ]
    }});
}

annotate CatalogService.MappingSteps with {
    conversionFunction @(Common: {ValueList: {
        $Type         : 'Common.ValueListType',
        Label         : 'Conversion Functions',
        CollectionPath: 'ConversionFunctions',
        Parameters    : [
            {
                $Type            : 'Common.ValueListParameterInOut',
                LocalDataProperty: conversionFunction_id,
                ValueListProperty: 'id'
            },
            {
                $Type            : 'Common.ValueListParameterDisplayOnly',
                ValueListProperty: 'name'
            },
            {
                $Type            : 'Common.ValueListParameterDisplayOnly',
                ValueListProperty: 'description'
            }
        ]
    }});
}
