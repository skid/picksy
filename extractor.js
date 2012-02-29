/**
 * Refinery Extractor.
 * Extracts text content from a DOM tree.
 * The DOM tree needs to be in the following form:
 *
   [{
     type: 'tag',
     name: 'html',
     attribs: {},
     children: [{
        type: 'tag',
        name: 'head',
        attribs: {},
        children: [...]
        }]
     }]
  
 * Useage:
 *
   extractor.analyze(dom);
   var text = extractor.getFormattedText(extractor.extract(dom));
 *
 */ 

var term  = require('./terminal');
var util  = require('util');

/*
 * Regular expression that matches all opening parentesis. Used for normalizing regularity patterns.
 */
var reg_parens = /\(/g;
/*
 * Regular expression that matches all blank spaces. Used for cleaning up HTML.
 */
var reg_space  = /[\s\n\r\t\» ]+/g;
/*
 * Regular expression that matches common non-word characters in HTML titles.
 * For insance, the pipe (|) in "Page Title | Site Name" is on of these.
 */
var reg_title  = /[|\-:/\s\n\r\t ]+/g;
/*
 * These are ignored and not counted towards scores or tag counts.
 */
var textTags   = ["i", "b", "u", "em", "strong", "q", "sub", "sup", "abbr", "strike"];
/*
 * When pretty-printing, these are not surrounded by newlines.
 */
var inlineTags = ['u', 'a', 'i', 'strong', 'em', 'b', 'q', 'sub', 'sup', 'abbr', 'span', 'cite', 'strike', 'code'];
/*
 * This is the legend for producing patterns. Each tag is represented by a different character.
 */
var legend = { a: "a", h1: "b", h2: "c", h3: "d", h4: "e", h5: "f", h6: "g", ul: "h", ol: "i", pre: "S",
  div: "j", article: "k", table: "l", tr: "m", td: "n", th: "o", tbody: "p", thead: "q", strike: "Q",
  footer: "r", header: "s", nav: "t", section: "x", form: "y", label: "0", fieldset: "z", cite: "P",
  button: "1", input: "2", select: "3", textarea: "4", audio: "5", u: "u", canvas: "6", b: "H",
  video: "7", img: "8", object: "9", hgroup: "A", p: "B",  blockquote:"C", i: "G", span: "F", code: "S",
  u: "I", strong: "J", em: "K", q: "L", sub: "M", sup: "N", abbr: "O", address: "D", li: "E", dl: "R",
}

// TODO: The tuning settings need explanation on their overall effect

var heightThreshold    = 5;  // Stop comparing and producing node patterns for nodes that are heigher than this
var anchorWeight       = 4;  // Added to the node's score if it is an anchor tag
var titleThreshold     = 5;  // Max number of words added to the page title (Name of site, etc...)
var nodeScoreThreshold = 10; // Scores bigger by a factor of this much are considered very unlikely to contain the text
var singleNodeCutoff   = 4;  // Candidate nodes that contain a single child and have height lesser than this are not analysed any further.

/*
 * A utility function that extracts the plain text from a tree of HTML nodes.
 */
function getText(node){
  var child, i=0, content = "";
  
  while(node.children && (child = node.children[i++])){
    if(child.type === 'text') {
      content += child.data;
    }
    else if(child.type === 'tag' && child.children && child.children.length){
      content += getText(child);
    }
  }
  return content;
}

/*
 * A utility function that prints the plain text from a node in a nicely formatted way.
 * Newlines are added after block elements. Multiple newlines are coerced.
 */
function getFormattedText(node){
  var child, c, content="", i = 0, n = inlineTags.indexOf(node.name) === -1;
  if(n) {
    content += "\n";
  }
  while(child = node.children[i++]){
    if(node.isTrash) {
      continue;
    }
    if(child.type === 'text') {
      content += child.data.replace(reg_space, ' ');
    }
    else if(child.type === 'tag' && child.children && child.children.length){
      c = getFormattedText(child);
      if(content.substr(-2) == '\n\n') {
        while(c[0] === '\n') {
          c = c.substr(1);
        }
      }
      content += c;
    }
  }
  if(n && content.substr(-2) !== '\n\n') {
    content += "\n";
  }
  while(content[0] + content[1] === '\n\n') {
    content = content.substr(1);
  }
  while(content[-2] + content[-1] === '\n\n') {
    content = content.substr(0, content.length-1);
  }
  return content;
}

/*
 * Prints a DOM tree and meta information obtained by htmlparser to stdout using colors.
 * This is for development purposes.
 */
function printTree(tree, options, depth) {
  var node, i = 0, 
      indent  = Array(depth || 0).join("|  "), 
      depth   = (depth || 1) + 1, 
      options = options || {},
      tree    = util.isArray(tree) ? tree : [tree];

  while(node = tree[i++]) {
    term.colorize('%y ' + indent);
    if(node.type === 'tag') {
      term.colorize('+ %r' + node.name);
      term.colorize(' %b height: ' + node.height);
      term.colorize(' %b words: '  + node.words + "|" + node.aWords );
      term.colorize(' %b score: '  + node.score );
      term.colorize(' %b tags: '   + node.tags );
      term.colorize(' %b longest: '+ node.longest );
      term.colorize(' %b title: '  + (node.title ? "YES" : ""));
      // term.colorize(' %b '  + node.pat );
      term.write("\n");
      
      if(node.children && node.children.length && (!options.cutoff || depth <= options.cutoff)){
        printTree(node.children, options, depth);
      }
    }
    else if(node.type === 'text'){
      term.colorize(term.reset);
      term.write(node.data);
      term.write("\n");
    }
    else {
      term.colorize('+ %r' + node.type);
      term.write("\n");
    }
  }
  term.colorize(term.reset);
}


/*
 * This function will go over a DOM tree and update its nodes with the following properties:

   tags:   [Number] Html tags in this node and all its subnodes (non-standard tags included)
   words:  [Number] Words in this node and all its subnodes
   aWords: [Number] Words that are enclosed in anchor tags
   depth:  [Number] Depth at which this node is found. The HTML (root) tag has depth 0.
   height: [Number] Height of this node's longest branch in nodes
   pat:    [String] Pattern describing the structure. Not calculated for nodes with depth > 5
   title:  [Number] This node contains the heading (itself or one of its children)
     
   score:  [Number] Repetitiveness of the node's contents. Calculated as:
     
                    ( SUM( (score(Mi) + 1) * C(Mi) * H(Mi) ) + SUM( score(Ni) + 1 ) ) / (cM + cN)
                    
                    Mi = Children nodes with identical patterns (groups)
                    cM = Total number of groups of children with identical patterns (gcount)
                    C  = Number of nodes in a group
                    Ni = Children that have a unique pattern within the node
                    cN = Total number of children with unique patterns (count)
                    H  = Node's pattern length. The pattern length depends on the number of children and
                          the node's height. For example:
                               a(ppppp) has a length of 7
                               a(a(ppp)a(ppp)a(ppp)) has a length of 17
                               a(a(a(p))) has a length of 7
                          We want to give each nesting only +1 to pattern length, but patterns
                          require opening and closing braces to be distinguishable. That's why we remove the opening braces.
 */
function analyze(subtree, parent, root, depth) {
  var p, t, j, i=0, data, node, prev, name, subpattern, children, treepattern = "", sibling;
  var gkeys, score = 0, count = 0, gcount = 0, tags = [], groups = {};
  
  // Root node has no parent
  if( !parent ) {
    while(node = subtree[i++]){
      if(node.name && node.name.toLowerCase() === "html") {
        node.depth  = 0;
        node.height = 0;  
        node.score  = 1;  
        node.tags = node.words = node.aWords = 0;
        analyze(node.children, node, node, 0);
        return node;
      }
    }
    return null;
  }

  while(node = subtree[i++]){
    node.name  = name = (node.name && node.name.toLowerCase());
    node.root  = root;
    node.depth = depth;
    node.score = 1;
    node.words = node.aWords = 0;
    
    if(name === 'option' || node.type === 'directive' || name === 'noscript') {
      subtree.splice(--i, 1);
      continue;
    }

    if(node.type === 'script' || node.type ===  'style' || node.type === 'comment' || node.name === 'iframe' || node.name === 'frame' || node.name === 'object') {
      ++parent.tags;
      subtree.splice(--i, 1);
      continue;
    }

    if( node.type === 'text') {
      node.data = node.data.replace(reg_space, " ").replace(/&amp;?/g, '&').replace(/&apos;?/g, "'")
                           .replace(/&lt;?/g, '<').replace(/&gt;?/g, '>').replace(/&quot;?/g, '"').replace(/&nbsp;?/g, ' ');
      data = node.data.trim();

      // Ignore nodes without words
      if( !data || data === " " ) {
        subtree.splice(--i, 1);
        continue;
      }

      node.words = data.split(" ").length;
      parent.words += node.words;
      
      // Longest continuous sequence of words
      if(parent.longest < node.words) {
        parent.longest = node.words;
      }
      
      // Qualifies as a title node
      if( (root.titleWords) && (root.titleWords - node.words <= titleThreshold) && (root.titleWords - node.words >= 0) && (root.titleData.indexOf(data.toLowerCase()) !== -1) ){
        // There is a title element in the head containing the exact words as this node (plus maybe a few more).
        root.heading      = node.data.toLowerCase();
        root.headingNode  = parent;
        parent.title      = true;
      }

      // Merge adjacent text nodes
      if( (prev = subtree[i-2]) && prev.type === 'text' ){
        subtree.splice(--i, 1);
        prev.data  += node.data;
        prev.words += node.words;
        if(parent.longest < prev.words) {
          parent.longest = prev.words;
        }
      }
      else {
        ++score;
        ++count;
      }
      continue;
    }
    
    /***** Node is a tag *****/
    
    // Remove <br> tags and convert them to "\n". Join adjacent text nodes if necessary.
    // Do not count <br> as tags since they stand in place of the \n character.
    if( name === 'br' || name === 'hr') {
      subtree.splice(--i, 1);
      if( (prev = subtree[i-1]) && prev.type === 'text' ) {
        prev.data += "\n";
      }
      continue;
    }
        
    node.longest = 0;
    node.height  = 0;
    node.tags    = 0;
    node.parent  = parent;
    children     = node.children;

    if(children && children.length) {
      subpattern = analyze(children, node, root, depth + 1);      
      node.pat   = node.height <= heightThreshold ? (legend[name] || "$") + "(" + subpattern + ")" : "";
    }
    else {
      node.pat = legend[name] || "$";
    }
    
    if(textTags.indexOf(name) > -1 && node.height === 0) {
      // Text tag with height 0 (contains no other tags) - remove it.
      subtree.splice(--i, 1);
      if(node.children && node.children.length === 1) {
        // If it has children, they are text nodes - replace it with its contents.
        subtree.splice(i, 0, node.children[0]);
      }
      continue;
    }
    
    if(isNaN(node.score) || node.score === 0) {
      node.score = 1;
    }
    
    ++count;
    score += node.score;

    if(name === 'title') {
      root.titleData  = getText(node).trim().toLowerCase();
      root.titleWords = root.titleData.split(reg_title).length;
    }
    else if( name === 'a' ) {
      score += anchorWeight;
      node.aWords += node.words;
    }
    
    if(node.title) {
      parent.title = true;
    }

    if(parent.height <= node.height) {
      parent.height = node.height + 1;
    }
    
    parent.tags   += node.tags + 1;
    parent.words  += node.words;
    parent.aWords += node.aWords;
    
    if(node.longest > parent.longest) {
      parent.longest = node.longest;
    }

    j=0;
    if(node.height <= heightThreshold) {
      while(sibling = tags[j++]){
        if(sibling.pat && sibling.pat === node.pat) {
          if(node.pat in groups) {
            groups[node.pat] += node.score;
            score -= node.score;
            --count;
          }
          else {
            // When we first match a sibling, we create a group, so we need to remove this node and the sibling from the score
            score -= (node.score * 2);
            count -= 2;
            groups[node.pat] = (node.score * 2);
            ++gcount;
          }
          break;
        }
      }
      treepattern += node.pat;
    }

    tags.push(node);
  }
  
  var gkeys = Object.keys(groups);
  for(i=0, j=gkeys.length; i < j; ++i) {
    score += groups[gkeys[i]] * gkeys[i].replace(reg_parens, "").length;
  }
  parent.score = score / ((count + gcount) || 1);
  if(parent.score < 0) {
    // console.log(score, count, gcount)
    // process.exit(0)
  }
  return treepattern;
}

/*
 * Takes the output from analyze() and goes over the dom tree looking for the node that contains the text.
 * It then weeds out subnodes that probably contain trash, like share links, images, etc...
 */
function extract(root, options) {
  var options = options || {};
  
  if(util.isArray(root)) {
    root = root.filter(function(c){ return c.name && c.name.toLowerCase() === 'html'; });
    if(root.length === 1) {
      root = root.pop();
    }
  }

  if(!root.name || root.name.toLowerCase() !== 'html' || !root.children.length) {
    throw "Invalid DOM tree passed to extract. Can't find HTML node or it has no children.";
  }

  // Extract only the text. Ignore images and formatting. Not implemented.
  var to = 'textOnly' in options ? options.textOnly : true;
  
  var candidate = null;
  debugger;
  (function walk(parent) {
    if(parent.type !== 'tag' || !parent.children || !parent.children.length) {
      return;
    }
    var deep, winner, runnerup, node, i=0, children = parent.children;
    // If we are within a node that has half the height of the entire dome, we're in deep mode.
    // Score are expected to be more relevant in deep mode.
    
    // Determine the two child nodes with the most words in respect to the parent
    while(node = children[i++]) {
      if(node.type !== 'tag') {
        node.prob = 0;
        continue;
      }

      // Probability score that this node contains the text is the ratio of 
      // the words contained in this node and the total words in the parent
      node.prob = node.words / (parent.words || 1);

      // If the node contains the title, double the probability. 
      // No need to worry about adding up to 1.
      if(node.title) {
        node.prob *= 2;
      }

      // No words in this node
      if(!node.prob) {
        continue;
      }
      
      if(!winner || node.prob > winner.prob) {
        runnerup = winner;
        winner = node;
      }
    }
    
    if(!winner) {
      // There are no tag nodes within this node
      return;
    }
    
    if(!runnerup) {
      // There's only a single tag node.
      // In this case we take the parent if we're in deep mode because it usually means that there's a single <span> withn a <p>
      // If we're not in deep mode - it's probably a <div#container> within a <div#wrapper>
      if(winner.height < singleNodeCutoff) {
        return;
      }
      else {
        candidate = winner;
      }
    }
    
    else if(winner.score/runnerup.score > nodeScoreThreshold || (runnerup.height / root.height < 1/2 && winner.score/runnerup.score > nodeScoreThreshold/2) ) {
      // Special case - the winner is not decisive enough either because it contains too little text 
      // or because it has an abnormally large score for its height. Here we make the decision based on the score and the words.
      candidate = (winner.words * winner.words / winner.score) > (runnerup.words * runnerup.words / runnerup.score) ? winner : runnerup;
    }

    else if(parent.height / root.height < 1/2 && winner.prob + runnerup.prob < 2/3) {
      // The 2 most texty nodes do not contain at least 2/3 of the parent node's text and the parent node is pretty shallow (low height).
      // This is an indicator that there are several beefy nodes within the parent, so they are probably paragraphs within the candidate.
      return;
    }
    
    else if (winner.prob < 1/5) {
      // The candidate has less than a 1/5 of the words of the parent. We probably walked too deep and ignored its sibling text nodes.
      return;
    }
    
    else {
      candidate = winner;
    }
    
    walk(candidate);
  })(root);
  
  var step = 0;
  if(root.headingNode) {
    // Look at most 2 levels up
    while(step++ <= 2 && !candidate.title) {
      candidate = candidate.parent;
    }
  }
    
  // At this point we have a candidate node.
  // If the page has a title, then the title is contained within the candidate node, 
  // but it will also often contain othe trash like comments and social links, so we need to clean that up.
  (function clean(parent){
    var i=0, node, children = parent.children;
    var wordScore = parent.words / parent.score;

    while(node = children[i++]) {
      // Nodes with no words or children in them are discarded.
      if(node.type === 'text') {
        continue;
      }
      else if(node.words === 0 || !node.children) {
        node.isTrash = true;
        continue;
      }
      else if(root.headingNode === node) {
        continue;
      }
      // Nodes with score or height bigger than their longest continuous word sequence are discarded.
      // Nodes with score much bigger than their parent's are discarded.
      // Nodes that contain fewer than 1/3 of the candidate words AND have twice more tags than their longest word sequence are discarded.
      else if((node.longest < node.height) || 
              (node.height < 8 && node.longest < node.score) || 
              (node.score / parent.score > nodeScoreThreshold) || 
              (node.words / candidate.words < 1/3 && node.tags / node.longest > 2) ||
              (node.tags / node.longest > 5)
      ){
        node.isTrash = true;
        continue;
      }
      else if( children[i+1] === undefined && node.aWords / Math.max(node.words, 1) > 0.95 ) {
        // There are a max of 2 nodes after this one, and this node's link density is > 95%.
        // This is a strong indicator that the node contains links at the end of the article.
        node.isTrash = true;
      }
      else {
        clean(node);
      }
    }
  })(candidate);
  
  return candidate;
}

exports.extract          = extract;
exports.analyze          = analyze;
exports.printTree        = printTree;
exports.getFormattedText = getFormattedText;