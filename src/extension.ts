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

        host : string;
        port : number;
        user : string;
        pwd : string;

        docsDbNumber : string;
        mldbClient : ml.DatabaseClient;
        constructor(host : string, port : number, user : string, pwd : string, dbName : string) {
            this.contentDb = dbName;
            this.host = host;
            this.port = port;
            this.user = user;
            this.pwd = pwd;

            this.docsDbNumber = "0";
            this.mldbClient = ml.createDatabaseClient({
                host: host, port: port, user: user, password: pwd,
                authType: 'DIGEST'});
            this.mldbClient.eval("xdmp.database('"+ dbName +"')")
                .result(null,null).then((response) => {
                    this.docsDbNumber = response[0]['value'];
                });
        };

        toString() : string {
            return [this.host, this.port, this.user, this.pwd, this.contentDb].join(":");
        }

        compareTo(host : string, port : number, user : string, pwd : string, contentDb : string) : boolean {
            let newParams = [host, port, user, pwd, contentDb].join(":");
            return (this.toString() === newParams);
        }
    }

    function getDbClient() : marklogicVSClient {
        var cfg = vscode.workspace.getConfiguration();

        var host = String(cfg.get("marklogic.host"));
        var user = String(cfg.get("marklogic.username"));
        var pwd = String(cfg.get("marklogic.password"));
        var port = Number(cfg.get("marklogic.port"));
        var dbName = String(cfg.get("marklogic.documentsDb"));
        var commands = vscode.commands.getCommands();

        // if settings have changed, release and clear the client
        let mlc = <marklogicVSClient>context.globalState.get(mldbClient);
        if (mlc != null && !mlc.compareTo(host, port, user, pwd, dbName)) {
            mlc.mldbClient.release();
            context.globalState.update(mldbClient, null);
        }

        if (context.globalState.get(mldbClient) === null) {
            var newClient = new marklogicVSClient(host, port, user, pwd, dbName);
            try {
                context.globalState.update(mldbClient, newClient);
            } catch(e) {
                console.log("Error: " + JSON.stringify(e));
            }
        };
        return context.globalState.get<marklogicVSClient>("mldbClient");
    };

    function encodeLocation(uri: vscode.Uri) : vscode.Uri {
        let query = JSON.stringify([uri.toString()]);
        return vscode.Uri.parse(`${QueryResultsContentProvider.scheme}:results-for?${query}`);
    }

    /**
     * QueryResultsContentProvider implements vscode.TextDocumentContentProvider
     */
    class QueryResultsContentProvider implements vscode.TextDocumentContentProvider {
        private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
        public _cache = new Map<string, Object>();

        static scheme = 'xquery-result';
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

    function _sendXQuery(actualQuery : string, uri : vscode.Uri) {
        let db = getDbClient();

        let cfg = vscode.workspace.getConfiguration();
        let docdb = db.docsDbNumber;

        let query =
            'xquery version "1.0-ml";' +
            'declare variable $actualQuery as xs:string external;' +
            'declare variable $documentsDb as xs:string external;' +
            'let $options := ' +
            '<options xmlns="xdmp:eval">' +
            '   <database>{xdmp:database($documentsDb)}</database>' +
            '</options>' +
            'return xdmp:eval($actualQuery, (), $options)';
        let extVars = <ml.Variables>{'actualQuery': actualQuery, 'documentsDb': db.contentDb};

        db.mldbClient.xqueryEval(query, extVars).result(
            function(response) {
                console.log("response:" + JSON.stringify(response));
                provider.updateResultsForUri(uri, response);
                provider.update(uri);
            },
            function (error) {
                vscode.window.showErrorMessage(JSON.stringify(error.body.errorResponse.message));
                console.error("Error:" + JSON.stringify(error));
            });
    };

    function _sendJSQuery() : Object {
        var actualQuery = vscode.window.activeTextEditor.document.getText();
        var db = getDbClient();
        var responsePayload;
        db.mldbClient.eval(actualQuery).result(
            function(response) {
                vscode.window.showInformationMessage(JSON.stringify(response));
                responsePayload = response;
            },
            function (error) {
                vscode.window.showErrorMessage(JSON.stringify(error.body.errorResponse.message));
                console.error(JSON.stringify(error));
            });
        return responsePayload;
    };

    let provider = new QueryResultsContentProvider();
    let registration = vscode.workspace.registerTextDocumentContentProvider(
        QueryResultsContentProvider.scheme, provider);

    let sendXQuery = vscode.commands.registerTextEditorCommand('extension.sendXQuery', editor => {
        let actualQuery = editor.document.getText();
        let uri = encodeLocation(editor.document.uri);
        _sendXQuery(actualQuery, uri);
        return vscode.workspace.openTextDocument(uri).then(
            doc => vscode.window.showTextDocument(doc, editor.viewColumn + 1)),
            error => console.error(error);
    });
    let sendJSQuery = vscode.commands.registerCommand('extension.sendJSQuery', () => {_sendJSQuery()});

    context.subscriptions.push(sendXQuery);
    context.subscriptions.push(sendJSQuery);
}

// this method is called when your extension is deactivated
export function deactivate(context: vscode.ExtensionContext) {
    context.globalState.get<ml.DatabaseClient>("mldbClient").release();
    context.globalState.update("mldbClient", null);
}
