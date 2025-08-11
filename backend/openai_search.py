# Inspired by https://github.com/openai/gpt-oss/tree/main/gpt_oss/tools/simple_browser

import re
from urllib.parse import urljoin, urlparse

import requests
import html2text
import lxml.html
import lxml.etree
import pydantic


class PageContents(pydantic.BaseModel):
    """A model to hold the processed page content."""
    url: str
    text: str
    title: str
    urls: dict[str, str]


def remove_unicode_smp(text: str) -> str:
    """Removes Unicode characters in the Supplemental Multilingual Plane (SMP)."""
    smp_pattern = re.compile(r"[\U00010000-\U0001FFFF]", re.UNICODE)
    return smp_pattern.sub("", text)

def replace_node_with_text(node: lxml.html.HtmlElement, text: str) -> None:
    """Replaces an lxml node with plain text."""
    previous = node.getprevious()
    parent = node.getparent()
    if parent is None:
        return
    tail = node.tail or ""
    if previous is None:
        parent.text = (parent.text or "") + text + tail
    else:
        previous.tail = (previous.tail or "") + text + tail
    parent.remove(node)

def get_domain(url: str) -> str:
    """Extracts the domain from a URL."""
    if "http" not in url:
        url = "http://" + url
    return urlparse(url).netloc

def _get_text(node: lxml.html.HtmlElement) -> str:
    """Gets all text from a node, merging whitespace."""
    text = " ".join(node.itertext())
    return re.sub(r"\s+", " ", text).strip()

def _clean_links(root: lxml.html.HtmlElement, cur_url: str) -> dict[str, str]:
    """Replaces <a> tags with a textual representation and returns a url map."""
    urls: dict[str, str] = {}
    cur_domain = get_domain(cur_url)
    for i, a in enumerate(root.findall(".//a[@href]")):
        if a.getparent() is None:
            continue
        link = a.attrib["href"]
        if link.startswith(("mailto:", "javascript:")):
            continue
        text = _get_text(a)
        if not text:
            text = "link" # provide default text if link has no text
        try:
            link = urljoin(cur_url, link)
            domain = get_domain(link)
        except Exception:
            domain = ""
        if not domain:
            continue
        
        link_id = f"{len(urls)}"
        urls[link_id] = link
        
        if domain == cur_domain:
            replacement = f"[{text} ({link_id})]"
        else:
            replacement = f"[{text} ({domain}, {link_id})]"
        replace_node_with_text(a, replacement)
    return urls


def replace_images(root: lxml.html.HtmlElement) -> None:
    """Replaces <img> tags with their alt text."""
    for i, img_tag in enumerate(root.findall(".//img")):
        image_name = img_tag.get("alt", img_tag.get("title"))
        if image_name:
            replacement = f"[Image {i}: {image_name}]"
        else:
            replacement = f"[Image {i}]"
        replace_node_with_text(img_tag, replacement)


def html_to_text(html: str) -> str:
    """Converts HTML to a clean text format."""
    h = html2text.HTML2Text()
    h.ignore_links = True
    h.ignore_images = True
    h.body_width = 0
    h.ignore_tables = True
    h.ignore_emphasis = True
    return h.handle(html).strip()


def process_html(html: str, url: str) -> PageContents:
    """
    Main function to convert raw HTML into a clean, model-readable string.
    """
    html = remove_unicode_smp(html)
    try:
        root = lxml.html.fromstring(html)
    except lxml.etree.ParserError:
        # If parsing fails, fall back to a simpler text extraction
        return PageContents(url=url, text=html_to_text(html), title="Could not parse HTML", urls={})


    # Extract title
    title_element = root.find(".//title")
    if title_element is not None and title_element.text:
        title = title_element.text
    else:
        title = get_domain(url) or "Untitled"

    urls = _clean_links(root, url)
    replace_images(root)

    # Convert the cleaned tree back to HTML before final text conversion
    clean_html = lxml.etree.tostring(root, encoding="UTF-8").decode()
    
    text = html_to_text(clean_html)
    
    # Final whitespace cleanup
    text = re.sub(r"^\s+$", "", text, flags=re.MULTILINE)
    text = re.sub(r"\n(\s*\n)+", "\n\n", text)

    return PageContents(
        url=url,
        text=text,
        title=title,
        urls=urls,
    )


def get_url_content_as_string(url: str) -> str:
    """
    Takes a URL, fetches its content synchronously, and turns it into a 
    single string with its processed content.
    """
    try:
        response = requests.get(url, timeout=30)
        response.raise_for_status()  # Raise an exception for bad status codes
        html_content = response.text

        page_contents = process_html(html=html_content, url=url)

        return page_contents.text

    except requests.RequestException as e:
        return f"Error: Could not fetch URL content. Details: {e}"
    except Exception as e:
        return f"An unexpected error occurred: {e}"


def main():
    """Main function to run the example."""
    target_url = 'https://github.com/MapIV/pypcd4'
    print(f"Fetching and processing content from: {target_url}\n")
    
    content_string = get_url_content_as_string(target_url)
    
    print("--- Start of Processed Content ---")
    print(content_string)
    print("--- End of Processed Content ---")


if __name__ == "__main__":
    main()
