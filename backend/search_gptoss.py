import requests
from requests.packages.urllib3.exceptions import InsecureRequestWarning
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain.schema import Document
import re
from urllib.parse import urljoin, urlparse
import copy

# Import robust parsing libraries
import lxml.html
import lxml.etree
import html2text

requests.packages.urllib3.disable_warnings(InsecureRequestWarning)

# --- UTILITY FUNCTIONS FOR ROBUST PARSING (ADAPTED FROM 2ND IMPLEMENTATION) ---

def get_domain(url: str) -> str:
    """Extracts the domain from a URL."""
    if "http" not in url:
        url = "http://" + url
    return urlparse(url).netloc

def replace_node_with_text(node: lxml.html.HtmlElement, text: str):
    """Replaces an lxml node with a text string, preserving the tail text."""
    previous = node.getprevious()
    parent = node.getparent()
    if parent is None: return
    tail = node.tail or ""
    if previous is not None:
        previous.tail = (previous.tail or "") + text + tail
    else:
        parent.text = (parent.text or "") + text + tail
    parent.remove(node)

def clean_links_in_element(element: lxml.html.HtmlElement, base_url: str):
    """Replaces hyperlink tags within a given element with a readable format."""
    for a_tag in element.xpath(".//a[@href]"):
        href = a_tag.get("href")
        if not href or href.startswith(("mailto:", "javascript:")):
            text = ' '.join(a_tag.itertext()).strip()
            replace_node_with_text(a_tag, text) # Keep text, remove link
            continue
        full_url = urljoin(base_url, href)
        text = re.sub(r'\s+', ' ', ' '.join(a_tag.itertext())).strip()
        if not text:
            text = get_domain(full_url)
        replacement = f"{text}" # Keep the text simple, as link map is in metadata
        replace_node_with_text(a_tag, replacement)

def replace_images_in_element(element: lxml.html.HtmlElement):
    """Replaces image tags within an element with a placeholder."""
    for i, img_tag in enumerate(element.xpath(".//img")):
        alt = img_tag.get("alt", "").strip()
        replacement = f"[Image: {alt}]" if alt else f"[Image {i}]"
        replace_node_with_text(img_tag, replacement)

def get_clean_text_for_element(element: lxml.html.HtmlElement, base_url: str) -> str:
    """
    Takes a single lxml element, cleans it, and returns its text content
    using html2text to preserve formatting like lists and newlines.
    """
    # Deep copy to avoid modifying the tree while iterating
    el_copy = copy.deepcopy(element)
    
    # Run cleaning functions on the copied element
    clean_links_in_element(el_copy, base_url)
    replace_images_in_element(el_copy)

    # Convert just this element to HTML, then to text
    html = lxml.etree.tostring(el_copy, encoding="unicode")
    
    h = html2text.HTML2Text()
    h.body_width = 0 # No wrapping
    h.ignore_emphasis = True
    
    text = h.handle(html)
    
    # Final cleanup of excessive whitespace from html2text
    return re.sub(r'\n\s*\n', '\n\n', text).strip()

def find_main_content_lxml(root: lxml.html.HtmlElement) -> lxml.html.HtmlElement:
    """
    Finds the main content of a webpage using lxml and a series of selectors.
    Falls back to cleaning the <body> tag.
    """
    positive_selectors = [
        "main", "article", '#main', '#content', '.main-content', '.content', '.post'
    ]
    for selector in positive_selectors:
        container = root.cssselect(selector)
        if container:
            print(f"Found main content with selector: '{selector}'")
            return container[0]

    print("No specific main content container found. Falling back to <body>.")
    body = root.cssselect('body')
    if body:
        # We don't need to manually remove junk tags here, as the CONTENT_TAGS
        # whitelist in PageChunker will effectively achieve this.
        return body[0]
    return root # Fallback to the whole document if no body

# --- REVISED PageChunker ---
# This class now combines your original logic with the new, robust parsing functions.

class PageChunker:
    # Whitelist of tags to extract content from.
    CONTENT_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'pre', 'div', 'span']
    # Tags that signify a new logical section should start.
    BOUNDARY_TAGS = ['h1', 'h2', 'h3', 'h4']

    def __init__(self, merge_threshold_chars: int = 1000, min_chunk_size_chars: int = 100):
        self.merge_threshold = merge_threshold_chars
        self.min_chunk_size_chars = min_chunk_size_chars
        self._reset()

    def _reset(self):
        self.documents = []
        self.buffer = []
        self.buffer_size = 0

    def _flush_buffer(self, metadata):
        """Creates a Document from the buffer and clears it."""
        if self.buffer:
            content = "\n\n".join(self.buffer).strip()
            if len(content) > self.min_chunk_size_chars:
                self.documents.append(Document(page_content=content, metadata=metadata))
            self.buffer = []
            self.buffer_size = 0
    
    def process(self, page_link: str):
        self._reset()
        try:
            response = requests.get(page_link, verify=False, timeout=10)
            response.raise_for_status()
        except requests.exceptions.RequestException as e:
            print(f"Error fetching {page_link}: {e}")
            return []

        try:
            root = lxml.html.fromstring(response.text)
            content_container = find_main_content_lxml(root)
        except lxml.etree.ParserError:
            print(f"Failed to parse HTML from {page_link}")
            return []

        title = (root.findtext('.//title') or "No Title").strip()
        metadata = {"source": page_link, "title": title}

        # Build an XPath query to find any of our desired content tags.
        # This is more efficient than iterating through all elements.
        tags_xpath = " | ".join([f".//{tag}" for tag in self.CONTENT_TAGS])
        all_content_elements = content_container.xpath(tags_xpath)

        # Create a set of the elements for quick parent checks
        element_set = set(all_content_elements)

        for tag in all_content_elements:
            # This is the key logic: only process a tag if its parent is NOT also a content tag.
            # This avoids processing nested content (e.g., a <p> inside a <li>) twice.
            if tag.getparent() in element_set:
                continue

            # Use our robust function to get clean text for this specific element
            content = get_clean_text_for_element(tag, page_link)
            if not content:
                continue

            # Your original, excellent boundary logic is now back in place.
            if tag.tag in self.BOUNDARY_TAGS and self.buffer:
                self._flush_buffer(metadata)

            self.buffer.append(content)
            self.buffer_size += len(content)
            if self.buffer_size > self.merge_threshold:
                self._flush_buffer(metadata)

        self._flush_buffer(metadata) # Don't forget the last buffer
        return self.documents

# --- Main execution ---
page_link = "https://github.com/MapIV/pypcd4"

page_chunker = PageChunker()
merged_documents = page_chunker.process(page_link)

# The final splitting step remains the same.
if merged_documents:
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=1024,
        chunk_overlap=0,
        separators=["\n\n", "\n", " ", ""], # Standard separators
    )

    chunks = splitter.split_documents(merged_documents)

    print(f"\nCreated {len(merged_documents)} logical blocks before final splitting.")
    print(f"Split into {len(chunks)} final chunks.\n")
    for i, chunk in enumerate(chunks):
        print(f"--- Chunk {i+1} ---")
        print(chunk.page_content)
        print("-" * 20)
