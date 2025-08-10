import * as vscode from 'vscode';
import fetch from 'node-fetch'
import * as fs from 'fs';


export function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

// TODO: could be stored in extension memory

export class ContextViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'llmContextView';
	private _view?: vscode.WebviewView;

	constructor(private readonly _extensionUri: vscode.Uri, private _context: vscode.ExtensionContext) {}

	public resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: vscode.CancellationToken): Thenable<void> | void {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'src', 'webview')]
		}

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview)

		webviewView.webview.onDidReceiveMessage(async (data) => {
			const currentContext = this._context.workspaceState.get<any[]>('llmContext', []);

			switch(data.type) {
				case 'addFile': {
					const fileUri = await vscode.window.showOpenDialog({canSelectMany: false});
					if (fileUri && fileUri.length > 0) {
						// backend can also fetch
						const newContext = [...currentContext, {type: 'File', context: fileUri[0].fsPath}]
						await this._context.workspaceState.update('llmContext', newContext);
						this.updateView();
					}
					break;
				}
				case 'addUrl': {
					const url = await vscode.window.showInputBox({ prompt: 'Enter URL' });
					if (url && url.length > 0) {
						// TODO: on backend we want to fetch and summarize/parse website
						const newContext = [...currentContext, {type: 'Url', context: url}]
						await this._context.workspaceState.update('llmContext', newContext);
						this.updateView();
					}
					break;
				}
				// TODO: add option to edit inline
				case 'addText': {
					const text = await vscode.window.showInputBox({prompt: 'Enter Text', placeHolder: 'Enter text here...'})
					if (text && text.length > 0) {
						const newContext = [...currentContext, {type: 'Text', context: text}]
						await this._context.workspaceState.update('llmContext', newContext);
						this.updateView();
					}
					break;
				}
				case 'updateTextContext': {
					if (data.index >= 0 && data.index < currentContext.length) {
						const newContext = [...currentContext];
						newContext[data.index].context = data.context;
						await this._context.workspaceState.update('llmContext', newContext);
					}
					break;
				}
				case 'removeContext': {
                    const newContext = currentContext.filter((_, index) => index !== data.index);
                    await this._context.workspaceState.update('llmContext', newContext);
                    this.updateView();
                    break;
                }
                case 'clearContext': {
                     await this._context.workspaceState.update('llmContext', []);
                     this.updateView();
                     break;
                }
                case 'requestUpdate': {
                    this.updateView();
                    break;
                }
				case 'toggleWebSearch': {
					await this._context.workspaceState.update('llmContextWebSearchEnabled', data.enabled);
				}
			}
		})
	}

	public updateView() {
		if (!this._view) return;
		const context = this._context.workspaceState.get('llmContext', [])
		this._view.webview.postMessage({type: 'update', context})
		this._view.badge = {
			value: context.length,
			tooltip: `${context.length} context items`
		}
	}

	private _getHtmlForWebview(webview: vscode.Webview) {
		const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'index.html');
		return fs.readFileSync(htmlPath.fsPath, 'utf8');
	}	
}

/**
 * Checks if a line is semantically empty for Python code.
 * A line is considered semantically empty if it contains only whitespace,
 * or if it contains only whitespace followed by a comment.
 * @param line The line of text to check.
 */
function isLineSemanticallyEmpty(line: string): boolean {
	// The regex explained:
	// ^\s*      - Matches any whitespace at the start of the line.
	// (#.*)?    - Optionally matches a group:
	//   #       - A literal '#' character.
	//   .*      - Any character, zero or more times (the rest of the comment).
	// $         - Matches the end of the line.
	return /^\s*(#.*)?$/.test(line);
}

function insertAtPosition(text: string, insertLine: number, insertChar: number, insertText: string) {
	const lines = text.split('\n');

	// If the line doesn't exist, add empty lines up to that point
	while (lines.length <= insertLine) {
		lines.push('');
	}

	let line = lines[insertLine];
	if (insertChar > line.length) {
		line += ' '.repeat(insertChar - line.length);
	}
	const newLine =	line.slice(0, insertChar) + insertText + line.slice(insertChar);
	lines[insertLine] = newLine;

	return lines.join('\n');
}

function findEnclosingFunctionSymbol(symbols: vscode.DocumentSymbol[], pos: vscode.Position): vscode.DocumentSymbol | undefined {
	for (const symbol of symbols) {
		if (symbol.range.contains(pos)) {
			// might also be inside a more specific child symbol
			const childSymbol = findEnclosingFunctionSymbol(symbol.children, pos);
			if (childSymbol) return childSymbol;

			if (symbol.kind === vscode.SymbolKind.Function || symbol.kind === vscode.SymbolKind.Method) {
				return symbol;
			}
		}
	}
	return undefined;
}

async function getSymbolLocations(symbolLocations: any, document: vscode.TextDocument) {
	const timeoutMs = 5000;
	const ctsImplementations = new vscode.CancellationTokenSource();
	const implementationTimeout = setTimeout(() => ctsImplementations.cancel(), timeoutMs);

	const implementationPromises = symbolLocations.map((symbol: any) => {
		const position = new vscode.Position(symbol[1], symbol[2]);
		try {
			return vscode.commands.executeCommand<vscode.Location[]>(
				'vscode.executeImplementationProvider',
				document.uri,
				position,
				ctsImplementations.token
			)
			.then(locations => locations || [])
		} catch (error) {
			if (error instanceof vscode.CancellationError) {
				console.log(`Implementation search for '${symbol.name}' was cancelled.`);
				return [];
			}
			// Handle other potential errors
			console.error(`Error finding implementation for ${symbol.name}:`, error);
			return [];
		}
	})

	let nestedLocations = null;
	try {
		nestedLocations = await Promise.all(implementationPromises)
		// TODO: deduplicate
		// return nestedLocations;
		console.log(nestedLocations)
	} finally {
		clearTimeout(implementationTimeout)
		ctsImplementations.dispose()
	}

	const symbolImplementationLocations = [];
	for(let i = 0; i < symbolLocations.length; i++) {
		if (nestedLocations[i].length < 1) continue;
		const name = symbolLocations[i][0];
		const location = nestedLocations[i][0];
		const path = location.uri.path;
		if (path.includes('/stdlib/')) continue;
		symbolImplementationLocations.push({
			name,
			path,
			startLine: location.range.start.line,
			startCol: location.range.start.character,
			endLine: location.range.end.line,
			endCol: location.range.end.character,  // exclusive
		})
	}

	return symbolImplementationLocations;
}


let llmCompletionTriggered = false;

export function activate(context: vscode.ExtensionContext) {
	console.log('linecompletion is active');

	const contextProvider = new ContextViewProvider(context.extensionUri, context);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ContextViewProvider.viewType, contextProvider)
	);

	const provider: vscode.InlineCompletionItemProvider = {
		async provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position, completionContext: vscode.InlineCompletionContext, token: vscode.CancellationToken) {
			if (!llmCompletionTriggered) {
				return;
			}	
			llmCompletionTriggered = false;

			let contextLine = position.line;
			for (let i = contextLine; i >= Math.max(0, contextLine - 3); i--) {
				if (!isLineSemanticallyEmpty(document.lineAt(i).text)) {
					contextLine = i;
					break;
				}
			}

			console.log('Context line ' + contextLine)
			const contextPosition = new vscode.Position(contextLine, 0);

			const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
				'vscode.executeDocumentSymbolProvider',
				document.uri
			);

			const enclosingFunctionSymbol = findEnclosingFunctionSymbol(symbols, contextPosition);

			let startLine: number;
			let endLine: number;
			
			if (enclosingFunctionSymbol) {
				startLine = enclosingFunctionSymbol.range.start.line;
				endLine = Math.max(enclosingFunctionSymbol.range.end.line, position.line + 1);
			} else {
				console.log('no enclosing function found, using 10 lines around cursor as fallback context')
				startLine = Math.max(0, position.line - 10);
				endLine = position.line + 10;
			}

			const closeContextSource = await fetchSymbolImplementation([{
				name: '',
				path: document.uri.fsPath,
				startLine: position.line,
				startCol: 0,
				endLine: position.line,
				endCol: 100000,
				expand_to_class: true
			}]);
			if (!closeContextSource) {
				console.error('failed to fetch close context implementation')
				return [];
			}

			const closeContext = insertAtPosition(closeContextSource[0].text, position.line - closeContextSource[0].start_line, position.character, '/*@@*/')
			console.log(closeContext)

			if (enclosingFunctionSymbol) {
				let referenceLocations = await vscode.commands.executeCommand<vscode.Location[]>(
					'vscode.executeReferenceProvider',
					document.uri,
					enclosingFunctionSymbol.selectionRange.start
				);
				referenceLocations = referenceLocations.filter(
					location => location.range.start.line !== enclosingFunctionSymbol.selectionRange.start.line || location.uri.fsPath !== document.uri.fsPath
				)
				console.log(referenceLocations)
				const referenceImplementations = await fetchSymbolImplementation(referenceLocations.map(ref => ({
					name: '',
					path: ref.uri.fsPath,
					startLine: ref.range.start.line,
					startCol: ref.range.start.character,
					endLine: ref.range.end.line,
					endCol: ref.range.end.character,  // exclusive
				})))
				// for each referenceLocation, get the surrounding function or class or context (if in global context)
				console.log(referenceImplementations)
				// TODO: store all contexts and their uri and line range in dict, so that we can later easily remove duplicates
			}

			const symbolLocations = await fetchSymbolLocations(document.uri.fsPath, startLine, endLine);
			const symbolImplementationLocations = await getSymbolLocations(symbolLocations, document);
			const symbolImplementations = await fetchSymbolImplementation(symbolImplementationLocations);
			console.log(symbolImplementations)
			if (symbolImplementations == null) {
				console.error('failed to fetch symbol implementations')
				return [];
			}

			// symbolImplementations.unshift({text: closeContext})

// 			const wrappedSymbolImplementations = symbolImplementations.map(impl => {
// 				return `\`\`\`python
// ${impl.text}
// \`\`\``;
// 			});

			// const prompt = wrappedSymbolImplementations.join('\n\n')
			// console.log(prompt)

			console.log('starting fetch')	
			const suggestions = await fetchSuggestions({
				closeContext,
				symbolImplementations,
				llmContext: context.workspaceState.get<any>('llmContext', []),
				webSearchenabled: context.workspaceState.get<any>('llmContextWebSearchEnabled', false),
			});
			console.log('fetched ' + suggestions)

			if (!suggestions || suggestions.length == 0) {
				vscode.window.showInformationMessage('No suggestion returned from backend.');
				return [];
			}

			return suggestions.map((suggestion) => {
				return new vscode.InlineCompletionItem(suggestion)
			});
		}
	};

	vscode.languages.registerInlineCompletionItemProvider({ language: 'python' }, provider);

	const triggerCommand = vscode.commands.registerCommand('linecompletion.suggestFromContext', () => {
		llmCompletionTriggered = true;
		vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
	});

	context.subscriptions.push(triggerCommand)
}

// TODO: typing
async function fetchSymbolImplementation(symbolImplementationLocations: any): Promise<any[] | null> {
	try {
		const response = await fetch('http://127.0.0.1:7524/symbol_source', {
			method: 'POST',
			body: JSON.stringify(symbolImplementationLocations),
			headers: { 'Content-Type': 'application/json' }
		});

		if (!response.ok) {
			console.error('Backend returned error: ', response.status)
			console.error(response.text)
			return null;
		}

		return await response.json();
	} catch (err) {
		console.error('Error contacting backend:', err);
		return null;
	}
}

async function fetchSymbolLocations(path: string, start_line: number, end_line: number): Promise<any | null> {
	try {
		const response = await fetch('http://127.0.0.1:7524/symbol_locations', {
			method: 'POST',
			body: JSON.stringify({
				path: path,
				start_line: start_line,
				end_line: end_line,
			}),
			headers: { 'Content-Type': 'application/json' }
		});

		if (!response.ok) {
			console.error('Backend returned error: ', response.status)
			console.error(response.text)
			return null;
		}

		return await response.json();
	} catch (err) {
		console.error('Error contacting backend:', err);
		return null;
	}
}

async function fetchSuggestions(body: any): Promise<string[] | null> {
	try {
		const response = await fetch('http://127.0.0.1:7524/suggest', {
			method: 'POST',
			body: JSON.stringify(body),
			headers: { 'Content-Type': 'application/json' }
		});

		if (!response.ok) {
			console.error('Backend returned error: ', response.status)
			console.error(response.text)
			return null;
		}

		const data = await response.json();
		return data.response;
	} catch (err) {
		console.error('Error contacting backend:', err);
		return null;
	}
}

export function deactivate() {
	console.log('linecompletion is deactivated')
}
