# Picksy

Picksy is a scraper that will extract the relevant text from an HTML page like a blog post, a news article or anything that has a considerable chunk of text.

I developed it to help me scrape articles from the web that will be further used for data mining where absolutely precise extraction is not essential. 

I wouldn't suggest using it for projects like [Readability](http://www.readability.com/) since it will often show an extra link or gobble up an occasional table of contents. 

You should expect nothing useful from homepages, navigation/category pages, forums and discussion threads and web applications.

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
    
    // Anayze the dom and add various metrics to the nodes
    picksy.analyze(dom);
    // Print a formatted and colored tree of the DOM
    picksy.printTree(dom);
    // Get the text node that contains the meat of the text
    var textNode = picksy.extract(dom);
    // Get the actual text from the text node. "Formatted" means that block tags are surrounded by newlines.
    var text = picksy.getFormattedText()

## How it works

Picksy employs several heuristics for guessing where the text is. Read the comments in `extract.js` for more info. Here's some of them:

- A strong emplasis on the location of the title in the DOM.
- A "repetitiveness" score is calculated for nodes. Nodes that have repeating patterns are unlikely to contain the main text.
- Word count is taken into account rather than character count.
- Link density.
- Longest word sequence (uninterrupted by tags).
- Height of a node subtree.

## License

[MIT](http://mit-license.org/)