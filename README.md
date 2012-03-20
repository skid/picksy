# Picksy

Picksy is a scraper that will extract the relevant text from an HTML page like a blog post, a news article or anything that has a considerable chunk of text.

I developed it to help me scrape articles from the web that will be further used for data mining where absolutely precise extraction is not essential. 

I wouldn't suggest using it for projects like [Readability](http://www.readability.com/) since it will often show some extra link or gobble up an occasional table of contents. 

You should expect nothing useful from homepages, navigation/category pages and web applications, although some content will be extracted.

Picksy depends on [node-htmlparser](https://github.com/tautologistics/node-htmlparser) to provide its input and works directly on the DOM tree constructed by htmlparser.

## Usage

    var picksy = require('picksy');
    
    // Acquired by parsing a HTML page with node-htmlparser
    var dom = [{ 
     type: 'tag',
     name: 'html',
     attribs: {},
     children: [{
        type: 'tag',
        name: 'head',
        attribs: {},
        children: [...]
      },
      {
        type: 'tag',
        name: 'head',
        attribs: {},
        children: [...]
      }]
    }];
    
    // Anayze the dom and extract the text content
    var result = picksy.analyze(dom);
    // Print a formatted and colored tree of the DOM with some debug info.
    picksy.printTree(result.dom);
    // Get the node that contains the meat of the text
    result.textNode;
    // Get the actual text from the text node.
    result.content;

## How it works

Picksy employs several heuristics for guessing where the text is. Read the comments in `extractor.js` for more info. Here's a short list.

- Word count is taken into account rather than character count.
- Moving averages of words in a flattend DOM.
- Location of the title.
- Longest word sequence (uninterrupted by tags) vs depth of a node subtree.
- Number of words in link tags, number of LI tags.

## Example

Visit my blog page at [http://discobot.net/en/posts/picksy](http://discobot.net/en/posts/picksy) and you can use the bookmark to extract text from random pages.

## License

[MIT](http://mit-license.org/)