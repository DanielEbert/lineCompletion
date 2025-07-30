import * as vscode from 'vscode';
import fetch from 'node-fetch'

export function activate(context: vscode.ExtensionContext) {
	console.log('linecompletion is active');

	const triggerCommand = vscode.commands.registerCommand('linecompletion.suggestFromContext', () => {
		vscode.commands.executeCommand('editor.action.triggerSuggest');
	})

	context.subscriptions.push(triggerCommand)

	const suggestionProvider = vscode.languages.registerCompletionItemProvider(
		'python',
	{
		async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext) {
			console.log('tirggered')

			const line = position.line;
			const startLine = Math.max(0, line - 5);
			const range = new vscode.Range(startLine, 0, line, 0);
			const text = document.getText(range)

			console.log('starting fetch')	
			const suggestions = await fetchSuggestions(text)
			console.log('fetched ' + suggestions)

			if (!suggestions || suggestions.length == 0) {
				vscode.window.showInformationMessage('No suggestion returned from backend.');
				return [];
			}

			return suggestions.map((suggestion, index) => {
				const completion = new vscode.CompletionItem(suggestion)
				completion.insertText = new vscode.SnippetString(suggestion)
				completion.sortText = ' ' + index.toString().padStart(5, '0');
				completion.documentation = new vscode.MarkdownString((index + 1).toString())
				completion.kind = vscode.CompletionItemKind.Snippet;
				return completion;
			})
		}
	});

	context.subscriptions.push(suggestionProvider);
}

async function fetchSuggestions(contextText: string): Promise<string[] | null> {
	try {
		const response = await fetch('http://localhost:7524/suggest', {
			method: 'POST',
			body: JSON.stringify({ context: contextText }),
			headers: { 'Content-Type': 'application/json' }
		});

		if (!response.ok) {
			console.error('Backend returned error: ', response.status)
			console.error(response.text)
			return null;
		}

		const data = await response.json();
		return data.suggestions;
	} catch (err) {
		console.error('Error contacting backend:', err);
		return null;
	}
}

export function deactivate() {
	console.log('linecompletion is deactivated')
}
