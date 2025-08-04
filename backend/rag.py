import subprocess
import os
import tree_sitter
import tree_sitter_python as tsp
import json
import dataclasses
from dataclasses import dataclass
import builtins
import time
import inspect

PY_LANG = tree_sitter.Language(tsp.language())
builtin_names = set([
    name for name in dir(builtins)
    if inspect.isbuiltin(getattr(builtins, name))   # built-in functions like print
    or inspect.isfunction(getattr(builtins, name))  # rarely used but covers some cases
    or inspect.isclass(getattr(builtins, name))     # types and classes
])


@dataclass
class FunctionReference:
    filepath: str
    line: str
    text: bytes
    last_modified_timestamp_epoch: float


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

import line_profiler
@line_profiler.profile
def get_funcs(func_name: str, root_dir: str):
    # -u to whitelist venv, which has library functions
    cmd = f'rg -u --no-messages --type py "[ \\t]*def {func_name}\\(" --max-filesize 10M --json {root_dir} | jq -c \'select(.type == "match")\''
    rg_output_raw = subprocess.check_output(cmd, shell=True)

    func_locations = []
    for rg_output_line in rg_output_raw.splitlines():
        rg_output = json.loads(rg_output_line)
        filepath = rg_output['data']['path']['text']
        line = rg_output['data']['line_number']
        func_locations.append((filepath, line))

    funcs = []
    for filepath, line in func_locations:
        tree = tree_cache.get(filepath)
        root_node = tree.root_node

        node = root_node.named_descendant_for_point_range((line - 1, 0), (line - 1, 1000))
        if not node:
            continue

        while node and node.type != 'function_definition':
            node = node.parent
        
        if not node or node.type != 'function_definition':
            continue

        node_func_name = node.child_by_field_name('name').text.decode('utf-8')
        if func_name not in node_func_name:
            # occurs in e.g. a '# def xyz ... ' comment
            continue

        funcs.append(FunctionReference(
            filepath,
            node.start_point.row,
            node.text.decode('utf-8'),
            os.path.getmtime(filepath)
        ))
    
    return funcs


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
    functions_and_classes = list(set([m[1]['function_name'][0].text.decode('utf-8') for m in matches]) - builtin_names)

    breakpoint()

# idea is that if we call a class, we drag the class body into this definition. similar for functions
# TODO: exclude stdlib functions

my_code = b"""
import os
import pandas as pd

class MyProcessor:
    def process(self, data):
        df = pd.DataFrame(data)
        print("Processing data...")
        return df.head()

def main():
    data = {'col1': [1, 2], 'col2': [3, 4]}
    processor = MyProcessor()  # Class call (instantiation)
    result = processor.process(data) # Method call
    
    # Simple function call
    print(result)

    # Chained call
    path = os.path.join("my", "path") 
    
    # Function call with a function as an argument
    sorted_list = sorted([3, 1, 2])

if __name__ == "__main__":
    main()
"""

def main():
    get_called_functions_and_classes(my_code)

    root_dir = os.path.expanduser('~/P/lineCompletion')
    func_name = r'parse'

    start_time = time.time()
    funcs = get_funcs(func_name, root_dir)
    print('runtime', round(time.time() - start_time, 4))

    with open('funcs.json', 'w') as f:
        f.write(json.dumps([dataclasses.asdict(f) for f in funcs]))


main()


#     class_query = tree_sitter.Query(
#         PY_LANG,
#         """
#     (class_definition
#         name: (identifier) @class.name
#     ) @class.definition
#     """)
# 
#     class_query_cursor = tree_sitter.QueryCursor(class_query)
#     class_captures = class_query_cursor.captures(tree.root_node)
# 
#     classes = {}
#     for node_def, node_name in zip(class_captures['class.definition'], class_captures['class.name']):
#         classes[node_name.text.decode('utf-8')] = node_def.text.decode('utf-8')
# 
#     with open('classes.json', 'w') as f:
#         f.write(json.dumps(classes))

        
# TODO: also introduce fast search? how to find library implementation -> venv
