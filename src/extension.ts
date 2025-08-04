import * as vscode from 'vscode';
import fetch from 'node-fetch'
import MarkdownIt from 'markdown-it'

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

	const triggerCommand = vscode.commands.registerCommand('linecompletion.suggestFromContext', () => {
		llmCompletionTriggered = true;
		vscode.commands.executeCommand('editor.action.triggerSuggest');
	})

	context.subscriptions.push(triggerCommand)

	const suggestionProvider = vscode.languages.registerCompletionItemProvider(
		'python',
	{
		async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext) {
			if (!llmCompletionTriggered) return;
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

			let startLine = null;
			let endLine = null;
			
			if (enclosingFunctionSymbol) {
				startLine = enclosingFunctionSymbol.range.start.line;
				endLine = Math.max(enclosingFunctionSymbol.range.end.line, position.line + 1);
			} else {
				console.log('no enclosing function found, using 10 lines around cursor as fallback context')
				startLine = Math.max(0, position.line - 10);
				endLine = position.line + 10;
			}

			const symbolCode = document.getText(new vscode.Range(startLine, 0, endLine, 0));
			const closeContext = insertAtPosition(symbolCode, position.line - startLine, position.character, '/*@@*/')
			console.log(closeContext)

			const symbolLocations = await fetchSymbolLocations(document.uri.fsPath, startLine, endLine);
			const symbolImplementationLocations = await getSymbolLocations(symbolLocations, document);
			const symbolImplementations = await fetchSymbolImplementation(symbolImplementationLocations);
			console.log(symbolImplementations)
			if (symbolImplementations == null) {
				console.error('failed to fetch symbol implementations')
				return [];
			}

			symbolImplementations.unshift(closeContext)

			const wrappedSymbolImplementations = symbolImplementations.map(impl => {
				return `\`\`\`python
${impl}
\`\`\``;
			});

			const prompt = wrappedSymbolImplementations.join('\n\n')
			console.log(prompt)
			// TODO: add each symbolImplementation in its own ```python block

			console.log('starting fetch')	
			const suggestions = await fetchSuggestions(prompt)
			console.log('fetched ' + suggestions)

			if (!suggestions || suggestions.length == 0) {
				vscode.window.showInformationMessage('No suggestion returned from backend.');
				return [];
			}

			const wordRange = document.getWordRangeAtPosition(position)

			let replaceRange: vscode.Range;
			let currentWordPrefix: string;

			if (wordRange) {
				replaceRange = new vscode.Range(wordRange.start, position)
				currentWordPrefix = document.getText(replaceRange)
			} else {
				replaceRange = new vscode.Range(position, position)
				currentWordPrefix = ''
			}

			return suggestions.map((suggestion, index) => {
				const completion = new vscode.CompletionItem(currentWordPrefix + suggestion)
				completion.insertText = new vscode.SnippetString(currentWordPrefix + suggestion)
				completion.sortText = '\0' + index.toString().padStart(5, '0');
				completion.documentation = new vscode.MarkdownString((index + 1).toString())
				completion.range = replaceRange;
				completion.kind = vscode.CompletionItemKind.Snippet;
				return completion;
			})
		}
	});

	context.subscriptions.push(suggestionProvider);
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

async function fetchSuggestions(contextText: string): Promise<string[] | null> {
	try {
		const response = await fetch('http://127.0.0.1:7524/suggest', {
			method: 'POST',
			body: JSON.stringify({
				context: contextText
			}),
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

async function fetchSuggestionsOllama(contextText: string): Promise<string[] | null> {
	try {
		const response = await fetch('http://192.168.178.36:11434/api/generate', {
			method: 'POST',
			body: JSON.stringify({
				model: 'qwencodercustom',
				prompt: contextText,
				stream: false
			}),
			headers: { 'Content-Type': 'application/json' }
		});

		if (!response.ok) {
			console.error('Backend returned error: ', response.status)
			console.error(response.text)
			return null;
		}

		const data = await response.json();
		const promptResponse = data.response;

		const md = new MarkdownIt();
		const parsed = md.parse(promptResponse, {});
		const codeBlocks = parsed
			.filter(token => token.type === 'fence')
			.map(token => token.content);
		return codeBlocks;
	} catch (err) {
		console.error('Error contacting backend:', err);
		return null;
	}
}

export function deactivate() {
	console.log('linecompletion is deactivated')
}
