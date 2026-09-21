# Chatbot conversazionale

Layer isolato che gestisce la chat dell'app *AP Invoice Extraction*. È volutamente
separato dalla pipeline di estrazione: nessun file esistente di `srv/lib` o
`srv/handlers` è stato modificato nella sua logica, quindi il flusso di estrazione,
mapping e registrazione fatture resta identico a prima.

## Struttura

| File | Responsabilità |
|------|----------------|
| `ChatbotConfig.js` | Configurazione della chat (modello, temperatura, storico, timeout, tool). Riusa da `AICoreConfig` solo destination e resource group, il resto è indipendente. |
| `ChatbotPrompts.js` | Costruzione del system prompt per sezioni (persona, conoscenza applicativa, regole di risposta, regole sui tool, contesto utente, lingua). |
| `ChatbotTools.js` | Registry dei tool esposti al modello. Indipendente da `srv/lib/AgentTools.js`, che resta al servizio dell'agente di estrazione. |
| `ConversationStore.js` | Memoria della conversazione, con backend `db` (tabella `db.ChatMessages`) o `memory` e fallback automatico. |
| `ChatbotAgent.js` | Runtime LLM: client SAP AI Core (Orchestration) e grafo LangGraph con loop dei tool. |
| `ChatbotService.js` | Caso d'uso di un turno di conversazione: validazione, storico, prompt, tool, chiamata al modello, persistenza, fallback. |

Il flusso di una richiesta è:

```
OData action chatbotMessage
  -> srv/handlers/ChatbotHandler.js      (adapter CAP, nessuna logica)
    -> ChatbotService.handleMessage()    (orchestrazione del turno)
      -> ConversationStore               (storico)
      -> ChatbotPrompts                  (system prompt)
      -> ChatbotTools                    (tool, se abilitati)
      -> ChatbotAgent.runTurn()          (SAP AI Core + LangGraph)
```

`ChatbotService` non conosce CAP: la chat è pilotabile anche da uno script di test o
da un altro protocollo.

## Contratto verso la UI

```
action chatbotMessage(message: String, sessionId: String null, locale: String null)
    returns { reply, timestamp, sessionId }
```

`sessionId` e `locale` sono opzionali: un client che invia solo `message` continua a
funzionare, la conversazione viene semplicemente creata nuova ad ogni messaggio. La UI
(`app/ap_invoice_extraction/webapp/controller/Chatbot.js`) memorizza il `sessionId`
restituito e lo rimanda al messaggio successivo, così l'assistente mantiene il contesto.

Lo storico è isolato per utente: il `sessionId` di un utente non dà accesso alla
conversazione di un altro.

## Configurazione

Blocco `cds.chatbot` in `package.json`, sovrascrivibile da variabili d'ambiente
(utile per differenziare gli spazi BTP senza rebuild):

| Chiave | Variabile d'ambiente | Default | Note |
|--------|----------------------|---------|------|
| `enabled` | `CHATBOT_ENABLED` | `true` | `false` fa rispondere il testo statico di fallback, senza chiamare il modello |
| `model` | `CHATBOT_AI_MODEL` | `gemini-2.5-pro` | indipendente dal modello usato per l'estrazione |
| `temperature` | `CHATBOT_AI_TEMPERATURE` | `0.3` | |
| `maxOutputTokens` | `CHATBOT_MAX_OUTPUT_TOKENS` | `1024` | |
| `timeoutMs` | `CHATBOT_TIMEOUT_MS` | `60000` | oltre il quale l'utente riceve il fallback invece di una chat bloccata |
| `historyLength` | `CHATBOT_HISTORY_LENGTH` | `20` | messaggi rimandati al modello |
| `historyStore` | `CHATBOT_HISTORY_STORE` | `db` | `db` o `memory` |
| `historyTtlMinutes` | `CHATBOT_HISTORY_TTL_MINUTES` | `720` | dopo tanta inattività la conversazione riparte da zero |
| `systemPrompt` | `CHATBOT_SYSTEM_PROMPT` | - | sostituisce integralmente il prompt generato |
| `tools.enabled` | `CHATBOT_TOOLS_ENABLED` | `false` | vedi sotto |
| `tools.disabled` | `CHATBOT_TOOLS_DISABLED` | `[]` | nomi da escludere, anche a tool attivi |
| `tools.maxIterations` | `CHATBOT_TOOLS_MAX_ITERATIONS` | `6` | giri massimi del loop modello/tool |

`destination` e `resourceGroup` seguono `AICoreConfig` (`AI_Core` / `default`) e sono
sovrascrivibili con `CHATBOT_AI_DESTINATION` e `CHATBOT_AI_RESOURCE_GROUP`.

## Tool

L'infrastruttura è pronta ma **disattivata**: con `tools.enabled: false` il modello non
riceve alcun tool e la chat è puramente conversazionale. Per attivarla basta mettere
`true` nel blocco `cds.chatbot.tools` oppure `CHATBOT_TOOLS_ENABLED=true`.

Sono già registrati due tool di esempio, entrambi in sola lettura:

- `getCurrentDateTime` - data e ora del server, per le domande con date relative;
- `searchInvoiceDocuments` - ricerca sui documenti caricati (nome file, numero fattura,
  fornitore, company code, stato) con un massimo di 20 risultati.

Un tool è un descrittore:

```js
{
    name: 'getInvoiceDetail',
    description: 'Quando il modello deve usarlo (è la sola cosa che il modello legge)',
    schema: z.object({ id: z.string().describe('Id del documento') }),
    handler: async (args, context) => 'sempre una stringa'
}
```

Per aggiungerne uno: si inserisce il descrittore in `DEFINITIONS` dentro
`ChatbotTools.js`, oppure si chiama `registerChatbotTool(definition)` da un altro
modulo. `context` contiene i dati della richiesta (`userId`, `locale`, `entities`),
quindi gli handler non devono usare variabili globali. Il wrapper si occupa già di
troncare output troppo lunghi e di trasformare un'eccezione in un messaggio di errore
per il modello, senza far fallire il turno di chat.

Regole pratiche per i nuovi tool: sola lettura dove possibile, output compatto
(il risultato rientra nella finestra di contesto), e filtro sui dati dell'utente
corrente quando il dato è sensibile.

## Persistenza

La tabella `db.ChatMessages` è scritta e letta solo da questo layer e **non è esposta**
in `CatalogService`: non è visibile né alle UI né alle API esistenti. Serve perché il
modulo `srv` può scalare fino a 5 istanze (vedi `mta.yaml`): con uno storico solo in
memoria la conversazione si spezzerebbe ad ogni richiesta servita da un'altra istanza.
Se il database non è raggiungibile, lo store passa automaticamente alla memoria di
processo e la chat continua a funzionare.

## Comportamento in errore

Ogni problema (chat disabilitata, AI Core non raggiungibile, deployment orchestration
non attivo, timeout, risposta vuota) produce un messaggio di cortesia localizzato
(it/en/es/pt) e **non** un errore OData: la UI non mostra mai un dialog di errore per
colpa dell'assistente. Il dettaglio tecnico finisce nei log del modulo `srv` con prefisso
`[Chatbot]`.
