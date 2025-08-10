import os
from google import genai
from google.genai import types
from fastapi import FastAPI
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import tree_sitter
import tree_sitter_python as tsp
import inspect
import builtins
from enum import Enum

from .openai_search import get_url_content_as_string


PY_LANG = tree_sitter.Language(tsp.language())
builtin_names = set([
    name for name in dir(builtins)
    if inspect.isbuiltin(getattr(builtins, name))   # built-in functions like print
    or inspect.isfunction(getattr(builtins, name))  # rarely used but covers some cases
    or inspect.isclass(getattr(builtins, name))     # types and classes
])


class TreeCache:
    def __init__(self):
        self.cache: dict[str, tuple[float, tree_sitter.Tree]] = {}
    
    def get(self, filepath: str):
        file_modified_time = os.path.getmtime(filepath)
        if filepath in self.cache and file_modified_time <= self.cache[filepath][0]:
            return self.cache[filepath][1]

        with open(filepath, 'rb') as f:
            source_code = f.read()
        parser = tree_sitter.Parser(PY_LANG)
        tree = parser.parse(source_code)

        self.cache[filepath] = (file_modified_time, tree)
        return tree
        

tree_cache = TreeCache()


class LLMContextType(str, Enum):
    file = "File"
    url = "Url"
    text = "Text"

class LLMContextEntry(BaseModel):
    type: LLMContextType
    context: str

class Context(BaseModel):
    main_text: str | None = None
    supplementary_text: list[str] = []
    urls: list[str] = []
    filepaths: list[str] = []

    # TODO
    symbol_implementations: list[str]
    web_search_enabled: bool


class ContextLocation(BaseModel):
    path: str
    start_line: int  # 0-based
    end_line: int  # inclusive


class SymbolLocation(BaseModel):
    name: str
    path: str
    startLine: int
    startCol: int
    endLine: int
    endCol: int  # exclusive
    expand_to_class: bool = False


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)


client = genai.Client(
    api_key=os.environ.get("GEMINI_API_KEY"),
)

def parse_llm_completion_output(output: str) -> list[str]:
    print(output)
    parts = output.split('---')
    print(parts)
    if len(parts) != 3:
        raise ValueError(f"Expected exactly 3 completions separated by '---', but found {len(parts)}.")

    return [completion.strip(' \n\t`') for completion in parts if completion.strip(' \n\t`')]


def generate(context: str):
    model = 'gemini-2.5-pro'

    contents = [
        types.Content(
            role="user",
            parts=[
                types.Part.from_text(text=context),
            ],
        ),
    ]
    generate_content_config = types.GenerateContentConfig(
        thinking_config = types.ThinkingConfig(
            thinking_budget=128,
        ),
        system_instruction=[
            types.Part.from_text(text=system_prompt),
        ],
        temperature=0
    ) 

    import time
    start_time = time.time()
    ret = parse_llm_completion_output(client.models.generate_content(
        model=model,
        contents=contents,
        config=generate_content_config,
    ).text)
    print('inference time:', round(time.time() - start_time), 2)

    return ret


@app.post('/suggest')
async def suggest(contextText: Context):
    print('on /suggest')
    if contextText.webSearchenabled:
        search_results = search(contextText.context)
    else:
        search_results = None

    context = f'{search_results}\n\nSource Code:\n{contextText.context}'

    print('context:')
    print(context)

    return {
        'response': generate(context)
    }


def get_called_functions_and_classes(src_code: str):
    parser = tree_sitter.Parser(PY_LANG)
    tree = parser.parse(src_code)

    query_string = """
    [
      ;; Case 1: Matches simple calls like `print()`
      (call
        function: (identifier) @function_name)

      ;; Case 2: Matches attribute calls like `obj.method()`
      ;; and captures only the final 'method' part.
      (call
        function: (attribute
                   attribute: (identifier) @function_name))
    ]
    """

    query = tree_sitter.Query(PY_LANG, query_string)
    cursor = tree_sitter.QueryCursor(query)
    matches = cursor.matches(tree.root_node)
    return matches


@app.post('/symbol_locations')
async def symbols(contextLocation: ContextLocation):
    with open(contextLocation.path, 'rb') as f:
        # maybe we can to give tree-sitter a partial file, but for now lets not risk it
        context = f.read()  # contextLocation.start_line:contextLocation.end_line + 1]
    matches = get_called_functions_and_classes(context)

    symbols = []
    for match in matches:
        match = match[1]['function_name'][0]
        name = match.text.decode('utf-8')
        if name in builtin_names:
            continue
        if match.start_point.row < contextLocation.start_line or match.start_point.row > contextLocation.end_line:
            continue
        symbols.append((name, match.start_point.row, match.start_point.column))
    
    return symbols


@app.post('/symbol_source')
async def symbol_source(symbol_locations: list[SymbolLocation]):
    ret = []

    for symbol_location in symbol_locations:
        tree = tree_cache.get(symbol_location.path)
        node = tree.root_node.named_descendant_for_point_range((symbol_location.startLine, symbol_location.startCol), (symbol_location.endLine, symbol_location.endCol))
        if not node:
            continue

        target_node_types = {'function_definition', 'class_definition'}

        while node and node.type not in target_node_types:
            node = node.parent
        
        if not node or node.type not in target_node_types:
            continue

        node_func_name = node.child_by_field_name('name').text.decode('utf-8')
        if symbol_location.name and symbol_location.name not in node_func_name:
            # occurs in e.g. a '# def xyz ... ' comment
            continue
    
        if node.type == 'function_definition' and symbol_location.expand_to_class:
            parent = node.parent
            while parent:
                if parent.type == 'class_definition':
                    node = parent
                parent = parent.parent

        ret.append({
            'start_line': node.start_point.row,
            'start_col': node.start_point.column,
            'text': node.text.decode('utf-8')
        })
    
    return ret


def make_section(tag: str, title: str, content: str) -> str:
    return f'''\
# [{tag} Start] - {title}

{content}

# [{tag} End] - {title}
'''


@app.post('/context')
async def get_context(context: Context):
    sections = []

    if context.main_text:
        sections.append(make_section("TASK", "Main Content", context.main_text))

    if context.supplementary_text:
        combined_supplementary = "\n\n---\n\n".join(context.supplementary_text)
        sections.append(make_section("CONTEXT", "Additional Information", combined_supplementary))

    for filepath in context.filepaths:
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                filecontent = f.read()
            sections.append(make_section("FILE", filepath, filecontent))
        except Exception as e:
            print(f"Failed to read {filepath}: {e}")

    for url in context.urls:
        try:
            page_content = get_url_content_as_string(url)
            sections.append(make_section("URL", url, page_content))
        except Exception as e:
            print(f"Failed to get page content for {url}: {e}")

    if context.main_text:
        sections.append(make_section("TASK", "Main Content", context.main_text))

    return "\n\n---\n\n".join(sections)


def main():
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=7524,
        workers=1,
        reload=False
    )

if __name__ == '__main__':
    main()
