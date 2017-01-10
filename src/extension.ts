'use strict';
import * as vscode from 'vscode';
import * as ml from 'marklogic';

export function activate(context: vscode.ExtensionContext) {

    const mldbClient = 'mldbClient';
    context.globalState.update(mldbClient, <ml.DatabaseClient>null);

    /**
     * marklogicVSClient
     */
    class marklogicVSClient {
        contentDb : string;
        modulesDb : string;

        host : string;
        port : number;
        user : string;
        pwd : string;

        docsDbNumber : string;
        mldbClient : ml.DatabaseClient;
        constructor(host : string, port : number,
                    user : string, pwd : string,
                    contentDb : string, modulesDb : string) {
            this.contentDb = contentDb;
            this.modulesDb = modulesDb;
            this.host = host;
            this.port = port;
            this.user = user;
            this.pwd = pwd;

            this.docsDbNumber = "0";
            this.mldbClient = ml.createDatabaseClient({
                host: host, port: port, user: user, password: pwd,
                authType: 'DIGEST'});
            this.mldbClient.eval("xdmp.database('"+ contentDb +"')")
                .result(null,null).then((response) => {
                    this.docsDbNumber = response[0]['value'];
                });
        };

        toString() : string {
            return [this.host, this.port, this.user, this.pwd, this.contentDb, this.modulesDb].join(":");
        }

        compareTo(host : string, port : number, user : string,
                pwd : string, contentDb : string, modulesDb : string) : boolean {
            let newParams = [host, port, user, pwd, contentDb, modulesDb].join(":");
            return (this.toString() === newParams);
        }
    }

    function getDbClient() : marklogicVSClient {
        var cfg = vscode.workspace.getConfiguration();

        var host = String(cfg.get("marklogic.host"));
        var user = String(cfg.get("marklogic.username"));
        var pwd = String(cfg.get("marklogic.password"));
        var port = Number(cfg.get("marklogic.port"));
        var contentDb = String(cfg.get("marklogic.documentsDb"));
        var modulesDb = String(cfg.get("marklogic.modulesDb"));
        var commands = vscode.commands.getCommands();

        // if settings have changed, release and clear the client
        let mlc = <marklogicVSClient>context.globalState.get(mldbClient);
        if (mlc != null && !mlc.compareTo(host, port, user, pwd, contentDb, modulesDb)) {
            mlc.mldbClient.release();
            context.globalState.update(mldbClient, null);
        }

        if (context.globalState.get(mldbClient) === null) {
            var newClient = new marklogicVSClient(host, port, user, pwd, contentDb, modulesDb);
            try {
                context.globalState.update(mldbClient, newClient);
            } catch(e) {
                console.log("Error: " + JSON.stringify(e));
            }
        };
        return context.globalState.get<marklogicVSClient>("mldbClient");
    };

    function encodeLocation(uri: vscode.Uri, host: string, port: number) : vscode.Uri {
        let query = JSON.stringify([uri.toString()]);
        let newUri = vscode.Uri.parse(`${QueryResultsContentProvider.scheme}://${host}:${port}/${uri.path}?${query}`);
        let newUriString = newUri.toString();
        return newUri;
    }

    function myFormattingOptions(): vscode.FormattingOptions {
        return {tabSize: 2, insertSpaces: true}
    }

    /**
     * QueryResultsContentProvider implements vscode.TextDocumentContentProvider
     */
    class QueryResultsContentProvider implements vscode.TextDocumentContentProvider {
        private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
        public _cache = new Map<string, Object>();

        static scheme = 'mlquery';
        /**
         * Expose an event to signal changes of _virtual_ documents
         * to the editor
         */
        get onDidChange() {return this._onDidChange.event;};
        public update(uri: vscode.Uri) {this._onDidChange.fire(uri);};

        public updateResultsForUri(uri: vscode.Uri, val: Object) {
            this._cache.set(uri.toString(), val);
        };

        private unwrap(o: Object) : string {
            let value = JSON.stringify(o['value'])
            if (o['format'] === 'xml') {
                return JSON.parse(value);
            }
            return value;
        };

        public provideTextDocumentContent(uri: vscode.Uri): string {
            let results = this._cache.get(uri.toString());
            if (results) {
                let r = <Array<Object>> results;
                return r.map(o => this.unwrap(o)).join("\n");
            }
            return "pending..."
        }
    };

    function _handleResponseToUri(uri : vscode.Uri, response : Object) {
        let fmt = response[0]['format'];
        let responseUri = vscode.Uri.parse(`${QueryResultsContentProvider.scheme}://${uri.authority}${uri.path}.${fmt}?${uri.query}`);
        provider.updateResultsForUri(responseUri, response);
        provider.update(responseUri);
        return responseUri;
    };
    function _handleError(uri: vscode.Uri, error: any) {
        let errorMessage = "";
        let errorResultsObject = { datatype: "node()", format: "json", value: error};
        if (error.body.errorResponse === undefined) {
            // problem reaching MarkLogic
            errorMessage = error.message;
        } else {
            // MarkLogic error: useful message in body.errorResponse 
            errorMessage = error.body.errorResponse.message;
        }
        vscode.window.showErrorMessage(JSON.stringify(errorMessage));
        provider.updateResultsForUri(uri, [errorResultsObject]);
        provider.update(uri);
    };

    /**
     * Show the results of incoming query results (doc) in the (editor).
     * Try to format the results for readability.
     */
    function receiveDocument(doc: vscode.TextDocument, editor: vscode.TextEditor): void {
        vscode.window.showTextDocument(doc, editor.viewColumn + 1)
            .then(() =>
                vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', doc.uri, myFormattingOptions())
                    .then(
                    (edits: vscode.TextEdit[]) => {
                        let formatEdit = new vscode.WorkspaceEdit();
                        formatEdit.set(doc.uri, edits);
                        vscode.workspace.applyEdit(formatEdit);
                    },
                    error => console.error(error)));
    };

    function _sendXQuery(actualQuery: string, uri: vscode.Uri, editor: vscode.TextEditor): void {
        let db = getDbClient();
        let cfg = vscode.workspace.getConfiguration();

        let query =
            'xquery version "1.0-ml";' +
            'declare variable $actualQuery as xs:string external;' +
            'declare variable $documentsDb as xs:string external;' +
            'declare variable $modulesDb as xs:string external;' +
            'let $options := ' +
            '<options xmlns="xdmp:eval">' +
            '   <database>{xdmp:database($documentsDb)}</database>' +
            '   <modules>{xdmp:database($modulesDb)}</modules>' +
            '</options>' +
            'return xdmp:eval($actualQuery, (), $options)';
        let extVars = <ml.Variables>{
            'actualQuery': actualQuery,
            'documentsDb': db.contentDb,
            'modulesDb' : db.modulesDb
        };

        let response = db.mldbClient.xqueryEval(query, extVars).result(
            response => {
                let responseUri = _handleResponseToUri(uri, response);
                vscode.workspace.openTextDocument(responseUri)
                    .then(doc => receiveDocument(doc, editor))
            },
            error => _handleError(uri, error));
    };

    function _sendJSQuery(actualQuery: string, uri: vscode.Uri, editor: vscode.TextEditor): void {
        let db = getDbClient();
        let cfg = vscode.workspace.getConfiguration();

        let query = "xdmp.eval(actualQuery, {actualQuery: actualQuery}," +
            `{database: xdmp.database(contentDb), modules: xdmp.database(modulesDb)});`;

        let extVars = <ml.Variables>{
            'actualQuery': actualQuery,
            'contentDb': db.contentDb,
            'modulesDb': db.modulesDb
        }

        db.mldbClient.eval(query, extVars).result(
            response => {
                let responseUri = _handleResponseToUri(uri, response);
                vscode.workspace.openTextDocument(responseUri)
                    .then(doc => receiveDocument(doc, editor))
            },
            error => _handleError(uri, error))
    };

    let provider = new QueryResultsContentProvider();
    let registration = vscode.workspace.registerTextDocumentContentProvider(
        QueryResultsContentProvider.scheme, provider);

    let sendXQuery = vscode.commands.registerTextEditorCommand('extension.sendXQuery', editor => {
        let actualQuery = editor.document.getText();
        let host = getDbClient().host; let port = getDbClient().port;
        let qUri = encodeLocation(editor.document.uri, host, port);
        _sendXQuery(actualQuery, qUri, editor)
    });
    let sendJSQuery = vscode.commands.registerTextEditorCommand('extension.sendJSQuery', editor => {
        let actualQuery = editor.document.getText();
        let host = getDbClient().host; let port = getDbClient().port;
        let uri = encodeLocation(editor.document.uri, host, port);
        _sendJSQuery(actualQuery, uri, editor);
    });

    context.subscriptions.push(sendXQuery);
    context.subscriptions.push(sendJSQuery);
}

// this method is called when your extension is deactivated
export function deactivate(context: vscode.ExtensionContext) {
    context.globalState.get<ml.DatabaseClient>("mldbClient").release();
    context.globalState.update("mldbClient", null);
}
