# Line Completion Backend

A FastAPI-based backend service that provides intelligent code completion using Google's Gemini AI models, with optional web search integration and advanced code analysis capabilities.

## Features

- **AI-Powered Code Completion**: Generate intelligent code suggestions using Google Gemini models
- **Multiple Completion Modes**: 
  - Line completion: Single-line code suggestions
  - Chunk completion: Multi-line code block suggestions
- **Web Search Integration**: Optional web search using Exa API to enhance completion context
- **Code Analysis**: Parse and analyze Python code using Tree-sitter
- **Symbol Resolution**: Find and extract source code for functions and classes
- **Caching**: Intelligent caching of parsed syntax trees for performance
- **CORS Support**: Ready for frontend integration

## Installation

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd linecompletion/backend
````

2. __Install dependencies__:

   ```bash
   pip install -r requirements.txt
   ```

3. __Set up environment variables__:

   ```bash
   export GEMINI_API_KEY="your-gemini-api-key"
   ```

4. __Run the server__:

   ```bash
   python main.py
   ```

The server will start on `http://127.0.0.1:7524`

## API Endpoints

### POST `/suggest`

Generate code completion suggestions for a given context.

__Request Body__:

```json
{
  "closeContext": "string",
  "symbolImplementations": ["string"],
  "llmContext": [
    {
      "type": "File|Url|Text",
      "context": "string"
    }
  ],
  "webSearchenabled": boolean
}
```

__Response__:

```json
{
  "response": ["completion1", "completion2", "completion3"]
}
```

### POST `/symbol_locations`

Find all function and method calls within a specified code range.

__Request Body__:

```json
{
  "path": "string",
  "start_line": 0,
  "end_line": 10
}
```

__Response__:

```json
[
  ["function_name", line_number, column_number]
]
```

### POST `/symbol_source`

Retrieve source code for specified symbols (functions/classes).

__Request Body__:

```json
[
  {
    "name": "function_name",
    "path": "file_path",
    "startLine": 0,
    "startCol": 0,
    "endLine": 0,
    "endCol": 0,
    "expand_to_class": false
  }
]
```

__Response__:

```json
[
  {
    "start_line": 0,
    "start_col": 0,
    "text": "function source code"
  }
]
```

## Usage Examples

### Basic Code Completion

```python
import requests

# Request code completion
response = requests.post("http://127.0.0.1:7524/suggest", json={
    "closeContext": "def calculate_total(items):\n    total = 0\n    /*@@*/",
    "symbolImplementations": [],
    "llmContext": [],
    "webSearchenabled": False
})

completions = response.json()["response"]
print(completions)
# Output: ["for item in items:", "return sum(item.price for item in items)", "if not items:"]
```

### Code Completion with Web Search

```python
response = requests.post("http://127.0.0.1:7524/suggest", json={
    "closeContext": "import pandas as pd\ndf = pd.read_csv('data.csv')\n/*@@*/",
    "symbolImplementations": [],
    "llmContext": [],
    "webSearchenabled": True
})
```

### Symbol Analysis

```python
# Find function calls in a file
response = requests.post("http://127.0.0.1:7524/symbol_locations", json={
    "path": "example.py",
    "start_line": 0,
    "end_line": 50
})

symbols = response.json()
print(symbols)
# Output: [["print", 5, 4], ["len", 10, 8], ["open", 15, 12]]
```

## Configuration

### Environment Variables

- `GEMINI_API_KEY`: Your Google Gemini API key (required)

### Model Configuration

The service uses two Gemini models:

- `gemini-2.5-flash`: For search query generation (faster)
- `gemini-2.5-pro`: For code completion (higher quality)

### Exa API

The service includes an Exa API key for web search functionality. For production use, replace the hardcoded API key with an environment variable:

```python
exa = Exa(api_key=os.environ.get("EXA_API_KEY"))
```

## Architecture

### Core Components

1. __TreeCache__: Caches parsed syntax trees with file modification time tracking
2. __LLM Integration__: Handles communication with Google Gemini models
3. __Code Parser__: Uses Tree-sitter for Python code analysis
4. __Search Integration__: Optional web search for enhanced context

### Completion Modes

- __Line Completion__: Generates single-line code suggestions
- __Chunk Completion__: Generates multi-line code blocks representing logical steps

### Symbol Resolution

The service can:

- Parse Python code to find function/method calls
- Extract source code for functions and classes
- Handle both standalone functions and class methods
- Filter out built-in Python functions

## Dependencies

Key dependencies include:

- `fastapi`: Web framework
- `google-genai`: Google Gemini AI integration
- `tree-sitter`: Code parsing
- `tree-sitter-python`: Python language support
- `exa-py`: Web search API
- `uvicorn`: ASGI server
- `pydantic`: Data validation

See `requirements.txt` for complete dependency list.

## Development

### Running in Development Mode

```bash
python main.py
```

The server runs with:

- Host: `127.0.0.1`
- Port: `7524`
- Workers: `1`
- Reload: `False`

### Code Structure

- __Models__: Pydantic models for request/response validation
- __Caching__: File modification time-based caching for syntax trees
- __Parsing__: Tree-sitter integration for code analysis
- __AI Integration__: Gemini model integration with custom prompts
- __Search__: Optional web search for enhanced completion context

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

[Add your license information here]

## Support

For issues and questions, please use the GitHub issue tracker.
