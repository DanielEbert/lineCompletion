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
from exa_py import Exa
from enum import Enum
import requests
from requests.packages.urllib3.exceptions import InsecureRequestWarning
from bs4 import BeautifulSoup
import re
import copy

from .openai_search import get_url_content_as_string

# Suppress insecure request warnings
requests.packages.urllib3.disable_warnings(InsecureRequestWarning)


PY_LANG = tree_sitter.Language(tsp.language())
builtin_names = set([
    name for name in dir(builtins)
    if inspect.isbuiltin(getattr(builtins, name))   # built-in functions like print
    or inspect.isfunction(getattr(builtins, name))  # rarely used but covers some cases
    or inspect.isclass(getattr(builtins, name))     # types and classes
])

exa = Exa(api_key = os.getenv("EXA_API_KEY"))


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


# TODO: fix language
# TODO: if suggestion returns import, add to prompt and propmt again with max 3 iterations
def get_prompt(code_lines: str):
    return f"""
You are a code completion assistant.
Given the following lines of code, what is the single next line?
Only return the code for the very next line and nothing else. Do not use markdown, backticks, or any other formatting.

Code:
```python
{code_lines}
```
"""

system_prompt = """\
You are a **Code Chunk Completion Assistant**. Your sole purpose is to generate three distinct **code chunks** for a given placeholder `/*@@*/` in a block of code provided by the user. A **Code Chunk** is a short, multi-line block of code, like a paragraph in a book, that represents a single logical step in an algorithm.

Your instructions are as follows:

1.  **Analyze the User's Code**: Carefully examine the surrounding code to understand its purpose, algorithm, logic, and programming style.
2.  **Generate the Next Logical Step**: Create three distinct **Code Chunks**. These suggestions must represent the most likely next logical step in the code. Your suggestions can and should include control flow blocks (e.g., `if`, `for`, `while`), variable assignments, function calls, or a combination thereof.
3.  **Strictly Adhere to Context**: Each suggestion must be syntactically correct and logically sound. You are strictly forbidden from inventing or hallucinating any functions, methods, classes, or modules. Only use variables and functions that are explicitly defined or imported in the provided code snippet.
    *   Example: If the logical next step is to iterate over a list named `users`, suggest a loop that performs a meaningful action inside it, not just the declaration of the loop.
4.  **Strict Output Format**: You must output only the three code chunks, separated by `---`.
5.  **The code does not have to be final**: You may output a suggestion with the expectation that more code will follow later. A code chunk represents a single logical step, not the entire remaining implementation.

Your output must strictly adhere to this format:

```
<completion_1_chunk>
---
<completion_2_chunk>
---
<completion_3_chunk>
```

Crucially, do not include any other text in your response. No explanations, no introductory sentences, no "Here are the completions:", and no markdown code blocks like ```. Your entire response must consist only of the three code chunks and the two `---` separators.

---

### Example 1: Basic Variable and Conditional Logic

**Input:**
```python
def calculate_shipping_cost(weight, distance, is_express):
    base_cost = 10
    cost_per_kg = 2.5
    cost_per_km = 0.1

    total_cost = base_cost + (weight * cost_per_kg) + (distance * cost_per_km)
    /*@@*/
```

**Output:**
```python
if is_express:
    total_cost *= 1.5 # Apply a 50% surcharge for express shipping
return total_cost
---
if is_express:
    total_cost += 15.0 # Add flat express fee
return total_cost
---
# Ensure a minimum cost
if total_cost < 12.0:
    return 12.0
return total_cost
```

---

### Example 2: Iteration and Data Structure Manipulation

**Input:**
```python
def process_inventory(products):
    # products is a list of {'id': int, 'name': str, 'stock': int}
    out_of_stock_ids = []
    products_to_reorder = []
    /*@@*/
```

**Output:**
```python
for product in products:
    if product['stock'] == 0:
        out_of_stock_ids.append(product['id'])
---
for product in products:
    if product['stock'] < 10: # Reorder threshold
        products_to_reorder.append(product)
---
if not products:
    return # No products to process
```

---

### Example 3: API Response Handling (JavaScript)

**Input:**
```javascript
async function fetchArticles() {
  try {
    const response = await fetch('https://api.example.com/articles');
    /*@@*/
  } catch (error) {
    console.error('Failed to fetch articles:', error);
  }
}
```

**Output:**
```javascript
if (!response.ok) {
  throw new Error(`HTTP error! status: ${response.status}`);
}
const articles = await response.json();
return articles;
---
const data = await response.json();
console.log('Successfully fetched articles:', data.length);
return data;
---
if (response.status === 204) { // No Content
  return [];
}
const articles = await response.json();
return articles;
```

---

### Example 4: Object-Oriented Programming (OOP)

**Input:**
```python
class TextFile:
    def __init__(self, path):
        self.path = path
        self.file_handler = open(path, 'r')
        self.line_count = 0

    def read_line(self):
        self.line_count += 1
        return self.file_handler.readline()

    def close(self):
        self.file_handler.close()

report_file = TextFile('data/report.txt')
/*@@*/
```

**Output:**
```python
try:
    header = report_file.read_line()
    print(f"Report Header: {header.strip()}")
finally:
    report_file.close()
---
all_lines = []
for line in report_file.file_handler:
    all_lines.append(line.strip())
report_file.close()
---
try:
    content = report_file.file_handler.read()
    print(f"File contains {len(content)} characters.")
finally:
    report_file.close()
```

---

### Example 5: Data Filtering and Manipulation (using a library)

**Input:**
```python
import pandas as pd

data = {'employee_id':,
        'department': ['Sales', 'IT', 'IT', 'HR'],
        'salary':}
df = pd.DataFrame(data)

# Get all employees from the IT department
/*@@*/
```

**Output:**
```python
it_employees = df[df['department'] == 'IT'].copy()
it_employees['bonus'] = it_employees['salary'] * 0.1
---
it_salaries = df.loc[df['department'] == 'IT', 'salary']
average_it_salary = it_salaries.mean()
---
# Get employees from IT or HR
it_hr_employees = df[df['department'].isin(['IT', 'HR'])]
```

---

### Example 6: Mid-Algorithm Logic

**Input:**
```python
def find_first_negative(numbers):
    # numbers is a list of integers
    for index, num in enumerate(numbers):
        /*@@*/
    return -1 # Return -1 if no negative number is found
```

**Output:**
```python
if num < 0:
    return index # Found the negative number
---
# Skip non-negative numbers
if num >= 0:
    continue
return index
---
if num < 0:
    print(f"Found negative number at index {index}")
    return index
```
"""

linecompletion_system_prompt = """\
You are a line completion assistant. Your sole purpose is to generate exactly three different one-line code completions for a given placeholder /*@@*/ in a block of code provided by the user.

Your instructions are as follows:

1.  Analyze the User's Code: Carefully examine the surrounding code to understand its purpose, algorithm, logic, and programming style.
2.  Generate the Next Logical Step: Create three distinct, single-line code suggestions. These suggestions must represent the most likely next logical step in the code, not necessarily a final action. Your suggestions can and should include starting new control flow blocks (e.g., if, for, while), assigning variables, or calling existing functions.
3.  Strictly Adhere to Context: Each suggestion must be syntactically correct and logically sound. You are strictly forbidden from inventing or hallucinating any functions, methods, classes, or modules. Only use variables and functions that are explicitly defined or imported in the provided code snippet.
    * Example: If the logical next step is to iterate over a list named `users`, suggest the start of the loop (e.g., `for user in users:`), not a non-existent function that performs the loop's action (e.g., `process_all_users(users)`).
4.  Strict Output Format: You must output only the three lines of code, separated by `---`.
5.  The final code does not have to be final -- you may output a suggestion with the expecation that more code will follow later.

Your output must strictly adhere to this format:
```
<completion_1>
---
<completion_2>
---
<completion_3>
```

Crucially, do not include any other text in your response. No explanations, no introductory sentences, no "Here are the completions:", and no markdown code blocks like ```. Your entire response must consist only of the three code lines and the two --- separators.

---

### Example 1: Basic Variable and Conditional Logic

Input:
```python
def calculate_shipping_cost(weight, distance, is_express):
    base_cost = 10
    cost_per_kg = 2.5
    cost_per_km = 0.1

    total_cost = base_cost + (weight * cost_per_kg) + (distance * cost_per_km)
    /*@@*/
```

Output:
if is_express:
---
return total_cost
---
print(f"Calculated base cost: {total_cost}")

---

### Example 2: Iteration and Data Structure Manipulation

Input:
```python
def process_inventory(products):
    # products is a list of {'id': int, 'name': str, 'stock': int}
    out_of_stock_ids = []
    products_to_reorder = []
    /*@@*/
```

Output:
for product in products:
---
for i, product in enumerate(products):
---
if not products:

---

### Example 3: API Response Handling (JavaScript)

Input:
```javascript
async function fetchArticles() {
  try {
    const response = await fetch('https://api.example.com/articles');
    /*@@*/
  } catch (error) {
    console.error('Failed to fetch articles:', error);
  }
}
```

Output:
if (!response.ok) {
---
const articles = await response.json();
---
console.log('Response status:', response.status);

---

### Example 4: Object-Oriented Programming (OOP)

Input:
```python
class TextFile:
    def __init__(self, path):
        self.path = path
        self.file_handler = open(path, 'r')
        self.line_count = 0

    def read_line(self):
        self.line_count += 1
        return self.file_handler.readline()

    def close(self):
        self.file_handler.close()

report_file = TextFile('data/report.txt')
/*@@*/
```

Output:
first_line = report_file.read_line()
---
for line in report_file.file_handler:
---
print(f"Opened file at path: {report_file.path}")

---

### Example 5: Data Filtering and Manipulation (using a library)

Input:
```python
import pandas as pd

data = {'employee_id': [101, 102, 103, 104],
        'department': ['Sales', 'IT', 'IT', 'HR'],
        'salary': [70000, 85000, 92000, 68000]}
df = pd.DataFrame(data)

# Get all employees from the IT department
/*@@*/
```

Output:
it_employees = df[df['department'] == 'IT']
---
it_department_mask = df['department'] == 'IT'
---
it_salaries = df.loc[df['department'] == 'IT', 'salary']

---

### Example 6: Mid-Algorithm Logic

Input:
```python
def find_first_negative(numbers):
    # numbers is a list of integers
    for index, num in enumerate(numbers):
        /*@@*/
    return -1 # Return -1 if no negative number is found
```

Output:
if num < 0:
---
print(f"Checking index {index}: value {num}")
---
if num == 0:

"""

search_system_prompt = '''\
You are a search query generation assistant. Your sole purpose is to generate a single, effective Google search query that will help a developer or an AI code completion model find the necessary information to complete a piece of code.

You will be provided with a code snippet containing a placeholder `/*@@*/`. Your task is to analyze the code to understand its high-level objective and the immediate task at the placeholder.

Based on your analysis, generate a concise and effective search query. The query should be designed to find the most relevant library, module, function, or common programming pattern needed to proceed with the code.

Your Instructions:
1. Analyze the Code Context: Carefully examine the provided code, including imported libraries, defined variables, and the overall logic to understand what the program is trying to achieve.
2. Identify the Core Task: Determine the specific problem that needs to be solved at the `/*@@*/` location. What is the most likely next step?
3. Formulate an Effective Query: Create a search query that describes this core task. Your query should be broad enough to find canonical documentation or popular libraries but specific enough to be relevant. Focus on the "what," not the "how." For example, if the code needs to read a specific file type, a good query would be "python library to read parquet file," not "python open file and parse bytes."
4. Strict Output Format: You must output *only* the raw text of the search query. Do not include any other text, explanations, introductory sentences, or markdown formatting.

---

Example 1: Finding a Data Manipulation Method

Input:
```python
import pandas as pd

# Load data from a CSV file
df = pd.read_csv('sales_data.csv')

# Calculate the total sales for each product category
/*@@*/
```

Output:
pandas group by sum

---

Example 2: Finding a Library for a Specific Task

Input:
```python
from PIL import Image
import os

input_folder = "source_images"
output_folder = "processed_images"

for filename in os.listdir(input_folder):
    if filename.endswith((".png", ".jpg", ".jpeg")):
        img_path = os.path.join(input_folder, filename)
        img = Image.open(img_path)
        
        # Resize the image to a standard thumbnail size
        /*@@*/
```

Output:
python pillow resize image

---

### Example 3: Finding API/Framework Usage

Input:
```javascript
const express = require('express');
const app = express();
const port = 3000;

app.get('/api/data', (req, res) => {
  // The goal is to return a JSON response to the client
  const myData = { status: 'success', value: 42 };
  /*@@*/
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
```

Output:
express js send json response
'''

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

def generate_search_query(context: str):
    model = 'gemini-2.5-flash'

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
            types.Part.from_text(text=search_system_prompt),
        ],
        temperature=0
    ) 

    import time
    start_time = time.time()
    search_query = client.models.generate_content(
        model=model,
        contents=contents,
        config=generate_content_config,
    ).text
    print('inference time:', round(time.time() - start_time), 2)
    return search_query


def search(context: str):
    search_query = generate_search_query(context)
    print('Search query:', search_query)

    search_results = exa.search_and_contents(search_query, text = True, type = "fast")

    ret = 'Search Results:\n'
    for result in search_results.results:
        ret += f'{result.title}:\n'
        ret += result.text
        ret += '\n\n---\n\n'
    
    ret += 'End of Search Results'

    return ret


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


# TODO: add dependencies endpoint, to be inserted in prompt, by checking requirements.txt

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
