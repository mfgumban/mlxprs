import * as vscode from 'vscode'

class DatabaseItem extends vscode.TreeItem {
    constructor(label: string) {
        super(label, vscode.TreeItemCollapsibleState.None)
        this.tooltip = label
        this.description = label
    }
}

export class DatabasesProvider implements vscode.TreeDataProvider<DatabaseItem> {
    getTreeItem(element: DatabaseItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
        return element
    }

    getChildren(element?: DatabaseItem): vscode.ProviderResult<DatabaseItem[]> {
        if (element) {
            const databaseSubItems = [
                new DatabaseItem('Configuration'),
                new DatabaseItem('Indexes'),
                new DatabaseItem('Forests'),
            ]
            vscode.window.showInformationMessage('Loading databases element')
            //return Promise.resolve(databaseSubItems)
            return databaseSubItems
        } else {
            const databases = [
                new DatabaseItem('Documents'),
                new DatabaseItem('data-hub-STAGING'),
                new DatabaseItem('data-hub-FINAL'),
                new DatabaseItem('Security'),
            ]
            vscode.window.showInformationMessage('Loading databases')
            //return Promise.resolve(databases)
            return databases
        }
    }
}