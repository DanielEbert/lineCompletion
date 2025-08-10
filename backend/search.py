# TODO: make this standalone tool lib and put on github with good docs and name

import requests
from requests.packages.urllib3.exceptions import InsecureRequestWarning
from bs4 import BeautifulSoup
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain.schema import Document
import re
import copy

requests.packages.urllib3.disable_warnings(InsecureRequestWarning)

page_link = "https://github.com/MapIV/pypcd4"


def find_main_content(soup: BeautifulSoup) -> BeautifulSoup:
    """
    Finds the main content of a webpage by trying a series of increasingly
    general selectors. As a last resort, it cleans the <body> tag.
    """
    positive_selectors = [
        "main",
        "article",
        'div[id="main"]',
        'div[id="content"]',
        'div[class*="main-content"]',
        'div[class*="content"]',
        'div[class*="post"]'
    ]
    for selector in positive_selectors:
        container = soup.select_one(selector)
        if container:
            print(f"Found main content with selector: '{selector}'")
            return container

    print("No specific main content container found. Falling back to cleaning <body>.")
    
    body = copy.copy(soup.body)
    
    junk_selectors = [
        'nav', 'aside', 'footer', 'header', 'script', 'style',
        '[role="navigation"]', '[role="complementary"]', '[role="banner"]',
        '[id*="sidebar"]', '[class*="sidebar"]',
        '[id*="comments"]', '[class*="comments"]',
        '[id*="footer"]', '[class*="footer"]'
    ]
    
    for junk_selector in junk_selectors:
        for tag in body.select(junk_selector):
            tag.decompose()
            
            
    return body


class PageChunker:
    CONTENT_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'pre', 'code']
    BOUNDARY_TAGS = ['h1', 'h2', 'h3', 'h4']

    def __init__(self, merge_threshold_chars: int = 800, min_chunk_size_chars: int = 50):
        self.merge_threshold = merge_threshold_chars
        self.min_chunk_size_chars = min_chunk_size_chars
        self._reset()

    def _reset(self):
        self.documents = []
        self.buffer = []
        self.buffer_size = 0

    def _flush_buffer(self, metadata):
        if self.buffer:
            content = "\n\n".join(self.buffer)
            self.documents.append(Document(page_content=content, metadata=metadata))
            self.buffer = []
            self.buffer_size = 0
    
    def _merge_small_chunks(self):
        if not self.documents:
            return

        merged_docs = []
        current_doc = self.documents[0]

        for next_doc in self.documents[1:]:
            if len(next_doc.page_content) < self.min_chunk_size_chars:
                current_doc.page_content += "\n\n" + next_doc.page_content
            else:
                merged_docs.append(current_doc)
                current_doc = next_doc

        merged_docs.append(current_doc)
        
        self.documents = merged_docs

    def process(self, page_link):
        self._reset()
        try:
            response = requests.get(page_link, verify=False, timeout=10)
            response.raise_for_status()
        except requests.exceptions.RequestException as e:
            print(f"Error fetching {page_link}: {e}")
            return []

        soup = BeautifulSoup(response.text, "lxml")
        content_container = find_main_content(soup)
        if not content_container:
            return []

        metadata = {"source": page_link}
        for tag in content_container.find_all(self.CONTENT_TAGS):
            if tag.find_parent(self.CONTENT_TAGS):
                continue

            content = tag.get_text() if tag.name == 'pre' else re.sub(r'\s+', ' ', tag.get_text()).strip()
            if not content:
                continue

            if tag.name in self.BOUNDARY_TAGS:
                self._flush_buffer(metadata)
                self.buffer = [content]
                continue

            self.buffer.append(content)
            self.buffer_size += len(content)
            if self.buffer_size > self.merge_threshold:
                self._flush_buffer(metadata)

        self._flush_buffer(metadata)

        return self.documents


page_chunker = PageChunker()
merged_documents = page_chunker.process(page_link)

splitter = RecursiveCharacterTextSplitter(
    chunk_size=1024,
    chunk_overlap=100,
)

chunks = splitter.split_documents(merged_documents)

print(f"\nSplit into {len(chunks)} final chunks.\n")
for i, chunk in enumerate(chunks):
    print(f"--- Chunk {i+1} ---")
    print(chunk.page_content)
    print("-" * 20)
