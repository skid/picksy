/**
 * Refinery Extractor (picksy). Extracts text content from a DOM tree.
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
      },{
        type: 'tag',
        name: 'body',
        attribs: {},
        children: [...]
      }]
     }]

 * Usage:
 *
   var result = picksy.analyze(dom);

 * The 'result' will contain:
 *
   {
     info:      { },    // Object with statistics for the DOM
     textNode:  { },    // The node that is most likely to contain the text
     content:   "...",  // The extracted text content 
   }
 * 
 *
 * How we decide what the content node is ?
 
   - The dom tree is first prepared by: 
     - Calculating the number of words, links, list items in each node
     - Calculating the number of words contained in links (aWords)
     - Detecting if a node has the same words as the page title
     - Removing purely inline tags and concatenating surrounding text content (see textTags)
   - Afterwards, we try to locate the page title by looping over all nodes that contain the words from the page title.
     We score them by the largest sequence matching sequence found in the page title and we reward if they are found inside
     h1 or h2 tags. If no such nodes exist, then we get the single h1 or the single h2 to be the title node.
   - Then we score each node as a weighted average from the node word count and the surrounding nodes word counts. The nodes are
     treated as a flat array here (in order of appearance, not as a tree). If we've identified a title each subsequent node's score
     is multiplied by a factor that is proportional to the node's distance from the title. The score gradually drops to 0 as we approach
     the end of the document. We also calculate the average score of nodes that don't directly contain text. The average is the sum 
     of text-containing nodes over the number of text-containing nodes.
   - High-level filter: We walk the tree from the body node selecting the most probable container of the text based on several heuristics:
     - The number of words over the number of parent words
     - The node's average score
     - Whether the node contains the page title
     - If we can't find a decisive container, we stop looking
     - The number of 'li' tags in the node
     - The number of words in links in the node
   - Low-level filter: Since we've identified a container for the main text, we weed out unwanted nodes based on other heuristics:
     - The number of words links over the number of words
     - We track the series of node scores and look for a sudden drop in the score.
     - The height of the node (how many nodes deep it goes) over the longest word sequence it contains.
     
 */ 

var term = require('./terminal');
var util = require('util');

/*
 * Regular expression that matches all blank spaces. Used for cleaning up HTML.
 */
var reg_space  = /[\s\n\r\t ]+/g;
/*
 * Regular expression that matches common non-word characters in HTML titles.
 * For insance, the pipe (|) in "Page Title | Site Name" is on of these.
 */
var reg_title  = /[|\-:/\s\n\r\t\» ]+/g;
/*
 * These are ignored and not counted towards scores or tag counts.
 */
var textTags = ["i", "b", "u", "em", "strong", "q", "sub", "sup", "abbr", "strike", "del",  "ins"];
/*
 * Form elements
 */
var formTags = ["input", "textarea", "button", "select"];
/*
 * When pretty-printing, these are not surrounded by newlines.
 */
var inlineTags = ['u', 'a', 'i', 'strong', 'em', 'b', 'q', 'sub', 'sup', 'abbr', 'span', 'cite', 'strike', 'code',  "del",  "ins"];
/*
 * Tag factors that influence the score of an element
 */
var tagFactors = { p: 2, h4: 0.5, h5: 0.5, h6: 0.5, li: 0.5, a: 0.1 };

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
 * Removes consecutive blank spaces and does some basic HTML entities decoding.
 */
function cleanText(text){
  return text.replace(/&amp;?/g, '&').replace(/&apos;?/g, "'").replace(/&lt;?/g, '<').replace(/&gt;?/g, '>').replace(/&quot;?/g, '"').replace(/&nbsp;?/g, ' ').replace(reg_space, " ");
}

/*
 * Returns true if node A contains or is the same as node B
 */
function contains(a, b){
  if(a === b){
    return true;
  }
  if(a.children) {
    var n, i=0;
    while(n = a.children[i++]){
      if( contains(n, b) ) {
        return true;
      }
    }
  }
  return false;
}

/*
 * Escapes a string before we use it to make a new regexp.
 */
function regEscape(text) {
  return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
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
    if(node.ignored) {
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
    if(node.ignored && !options.showIgnored){
      continue;
    }
    term.colorize('%y ' + indent);
    if(node.type === 'tag') {
      term.colorize('+ %r' + node.name);
      term.colorize(' %b H: ' + node.height +  ' | D: ' + node.depth);
      term.colorize(' %b W ' + node.words + " | A " + node.aWords + " | L " + node.longest);
      term.colorize(' %b S ' + node.score + " | Sa " + (typeof node.avgScore === 'number' ? node.avgScore : "None") + " | N " + node.nodes);
      node.ignored && term.colorize(' %r IGNORED');
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


/**
 * This function will analyze and clean up the DOM.
 * It returns an info object that contains:
 *   text:      the extracted text
 *   links:     an array of links
 *   words:     the number of words
 *   nodes:     the number of nodes
 *   title:
**/
function analyze(dom, options){
  options = options || {};
  var halfBracket          = options.halfBracket         || 10,   // Half the width of the moving averages
      scoreRatioTitle      = options.scoreRatioTitle     || 10,   // If 2 nodes' scores differ by this much, the bigger is always selected
      metaScoreRatioTitle  = options.metaScoreRatioTitle || 5,    // If 2 nodes' meta scores differ by this much, the bigger is always selected
      maxWordRatioTitle    = options.maxWordRatioTitle   || .8,   // If a node contains this much of the parent's words it's always selected
      minWordRatioTitle    = options.minWordRatioTitle   || .1,   // If a node does not contain this much of the parent's words it's never selected
      scoreRatio           = options.scoreRatio          || 2.5,  // We use these numbers when we can't identify a title in the page.
      metaScoreRatio       = options.metaScoreRatio      || 2,
      maxWordRatio         = options.maxWordRatio        || .7,
      minWordRatio         = options.minWordRatio        || .1;

  var i=0, node, bodyNode, headNode, info = {
    words:    0,
    nodes:    0,
    links:    0,
    media:    0,
    title:    null,
    wordsInTitle:  0,
    scores: [],
    hrefs:  []
  };
  
  // Check if the dom is valid
  if(util.isArray(dom)) {
    dom = dom;
  }
  else if(dom.children && dom.children.length) {
    dom = dom.children;
  }
  else {
    return { status: "error", message: "Invalid dom object" };
  }

  // Find head and body nodes
  while(node = dom[i++]){
    if(typeof node.name !== "string") {
      continue;
    }
    if(node.name.toLowerCase() === "html") {
      i = 0; dom = node.children;
    }
    else if(node.name.toLowerCase() === "head") {
      headNode = node;
    }
    else if(node.name.toLowerCase() === "body") {
      bodyNode = node;
      break;
    }
  }

  if(!headNode || !bodyNode) {
    return { status: "error", message: "Can't find head or body node(s)" };
  }
  
  i=0;
  while(node = headNode.children[i++]){
    if(node.name && node.name.toLowerCase() === 'title'){
      info.title = getText(node).trim().toLowerCase();
      info.wordsInTitle = info.title.split(reg_title).length;
    }
  }
  
  bodyNode.depth   = 0;
  bodyNode.height  = 0;
  bodyNode.words   = 0;
  bodyNode.aWords  = 0;
  bodyNode.nodes   = 0;
  bodyNode.links   = 0;
  bodyNode.longest = 0;
  bodyNode.lis     = 0;

  var titleCandidates = [], h1s = [], h2s = [];
  var flattened = [];

  /**
   * Prepares the dom for further processing.
   * Merges adjacent text nodes, removes text-only inline tags that contain a single text node.
   * Builds arrays of possible titles, H1s and H2s.
   * Counts all kinds of statistics, like words, words in links, links, list items, etc ...
  **/
  (function prepare(parent, depth){
    var replace, words, data, prev, node, i=0, children = parent.children;
    
    // Loop children
    while(node = children[i++]){
      replace = null;

      // Text nodes
      if(node.type === 'text') {
        data = node.data = cleanText(node.data);
        
        // Ignore text nodes without words
        if(!data || data === " ") {
          children.splice(--i, 1);
          continue;
        }
        
        // Merge adjacent text nodes
        if((prev = children[i-2]) && prev.type === 'text'){
          prev.data     += node.data;
          parent.words  -= prev.words;
          parent.dWords -= prev.words;
          
          children.splice(--i, 1);
          --i;

          // Rerun the previous node
          flattened.pop();
          continue;
        }

        // Number of words
        data = data.trim();
        words = node.words = data.split(reg_space).length;
        parent.words  += node.words;
        parent.dWords += node.words;

        // Longest continuous sequence of words
        if(parent.longest < words) {
          parent.longest = words;
        }

        // Parent qualifies as a title node because it contains similar text to the head title.
        // Do not check text nodes that contain significantly more words than the title.
        if(info.wordsInTitle && words - info.wordsInTitle < 5) {
          words = data.split(reg_title).filter(function(w){ return w; }).length;
          // Title needs to have >= words and the actual data needs to be IN the title, and we also want to match the whole phrase/word, not just letters.
          if(words && info.wordsInTitle >= words && ~info.title.indexOf(data.toLowerCase()) && info.title.match(new RegExp("(\\s|^)" + regEscape(data) + "(\\s|$)", "i"))) {
            parent.words += words - node.words;
            node.words    = words;
            // If we matched a single word, and the real title contains more than 5 words - we probably matched a node containing a stopword
            if( node.words > 1 || info.wordsInTitle <= 5){
              titleCandidates.push(parent);
            }
          }
        }

        flattened.push(node);
        continue;
      }

      // Styles and comments are relatively insignificant and can occur anywhere. We ignore them.
      if(node.type ===  'style' || node.type === 'comment' || node.type === 'script' || node.name === 'noscript' || node.name === 'iframe' || node.name === 'frame') {
        children.splice(--i, 1);
        continue;
      }
      
      // Everything else from now on is a valid tag node.
      node.name = node.name.toLowerCase();

      // The following are tags that have no children or a special meaning.
      // Linebreaks and horizontal rules are replaced with newlines.
      if(node.name === 'br' || node.name === 'hr') {
        children.splice(--i, 1);
        if( (prev = children[i-1]) && prev.type === 'text' ) {
          prev.data += "\n";
        }
        continue;
      }
      
      // Place the node in the flattened tree
      flattened.push(node);

      node.parent  = parent;
      node.depth   = depth;
      node.height  = 0;
      node.words   = 0;
      node.aWords  = 0;
      node.dWords  = 0;
      node.nodes   = 0;
      node.links   = 0;
      node.longest = 0;
      node.score   = 0;
      node.lis     = 0;
      
      // This is a media container. Can be a relevant video inside content, or an ad. 
      // We do not walk it, but we might need the children for extracting videos. We move them to another property.
      if(node.name === 'object' || node.name === 'embed') {
        ++parent.nodes;
        node.params = node.children;
        delete node.children;
        continue;
      }
      
      // This is an image. Can be a relevant image inside continue, or an ad.
      else if(node.name === 'img') {
        ++parent.nodes;
        continue;
      }

      // Form elements usually mean a beginning of a comment block.
      if(~formTags.indexOf(node.name)) {
        ++parent.nodes;
        delete node.children; // Deletes option tags
        continue;
      }

      if(util.isArray(node.children)) {
        // If walk returns anything - it's a text node that is the only thing inside a text tag
        // In this case we just replace the node with its contents.
        replace = prepare(node, depth + 1);
        if(replace) {
          // If replace is boolean true, then we just remove the node. In case a text tag contains nothing.
          if(replace === true){
            children.splice(--i, 1);
          }
          else {
            children.splice(--i, 1, replace);
          }
          continue;
        }
      }
      
      if(node.name === 'a'){
        parent.links++;
        node.aWords += node.words;
        if(node.attribs && node.attribs.href && node.attribs.href[0] !== '#' && !~node.attribs.href.indexOf('javascript')) {
          info.hrefs.push({ text: getText(node), href: node.attribs.href, title: node.attribs.title || "" });
        }
      }
      else if(node.name === 'li' || node.name === 'dd' || node.name === 'dt'){
        parent.lis++;
      }
      else if(node.name === 'h1'){
        h1s.push(node);
      }
      else if(node.name === 'h2'){
        h2s.push(node);
      }

      parent.height   =  Math.max(node.height + 1, parent.height);
      parent.words    += node.words;
      parent.aWords   += node.aWords;
      parent.nodes    += node.nodes + 1;
      parent.links    += node.links;
      parent.longest  <  node.longest && (parent.longest = node.longest);
      parent.lis      += node.lis;

    } // End while loop
    
    // Remove textTags (like i, b, u, strong, em) that contain a single text node or no nodes
    if(children.length === 0 && ~textTags.indexOf(parent.name)) {
      flattened.pop();
      return true;
    }
    if(children.length === 1 && children[0].type === 'text' && ~textTags.indexOf(parent.name)) {
      flattened.pop();
      return children.pop();
    }

  })(bodyNode, 1);
  
  /**
   * Identify the title node:
   * We do this by identifying text nodes that have the same words as the head title.
   * If we get more matches we choose the strongest one.
   * If there is no head title, or no node matches the words in it - we choose the single H1.
   * If there are no H1 elements, we choose the single h2. If there are no H2s, or there are
   * nore than one, we simply fail - the page has no title.
  **/
  var titleNode, h1l, h2l;
  h1s = h1s.filter(function(node){ return node.words && node.words <= info.wordsInTitle; });
  h1s.forEach(function(h){ titleCandidates.forEach(function(node){ node.h1 = contains(h, node); }); });
  h2s = h2s.filter(function(node){ return node.words && node.words <= info.wordsInTitle; });
  h2s.forEach(function(h){ titleCandidates.forEach(function(node){ node.h2 = contains(h, node); }); });

  titleCandidates.forEach(function(node){ node.tscore = node.words/info.wordsInTitle; });
  titleNode = titleCandidates.sort(function(a, b){ 
    var res = b.tscore - a.tscore;
    return res ? res : ((b.h1 && !a.h1) || (b.h2 && !a.h2)) ? 1 : (a.h1 && !b.h1 || (a.h2 && !b.h2)) ? -1 : 0;
  })[0];

  if(!titleNode && h1s.length === 1){
    titleNode = h1s.pop();
  }
  else if(!titleNode && h2s.length === 1){
    titleNode = h2s.pop();
  }
  if(titleNode){
    var parent = titleNode;
    while(parent = parent.parent) {
      parent.containsTitle = true;
    }
  }
  
  /**
   * Assign scores to nodes
   * We loop over the tags in the dom, but in a flattened array.
   * Each tag's score is a weighted average of the 10 nodes before it and 10 nodes after it.
   * The score is calculated as:
   *    sum( abs(11 - DSTi) * Wi * TFi ) / sum(abs(11 - DSTi))
   * where:
   *    DSTi is the distance of the i-th node from the current one
   *    Wi   is the number of words directly contained in the i-th node (words in children do not count)
   *    TFi  is the tag factor of the i-th node ("a" tags get 0.1, "p" tags get 2, etc...)
   
   * This method will score very highly text that is clumped together and score lowly text that has a lot
   * of tags in between even if the text itself is long. This will assign low scores even on huge comment sections
   * since comments tend to have a big tag structure around them, while the meat of the article is usually 
   * separated only by paragraph tags. It will allso score low on repeating anchor tags but will have a small
   * impact if an anchor tags is surrounded by plain text.
  **/
  var titleFound  = false;
  var denominator = halfBracket * halfBracket + halfBracket * 2 + 1;
  var i, j, k, l, node, distance, words;
  for(i=0, j=flattened.length; i<j; ++i){

    node = flattened[i];
    node.score = 0;

    if(i < halfBracket || j - i < halfBracket) {
      continue;
    }
    
    if(!titleFound && titleNode && titleNode === node){
      titleFound = j-i; // rest of the tags
    }
    // Calculate the score as the weighted average of the node + fullBracked surrounding nodes.
    // Some nodes weigh more than others (like P)

    for(k = i - halfBracket, l = i + halfBracket + 1; k <= l; ++k){
      if((neigh = flattened[k]) && neigh.words){
        words       = neigh.type === 'text' ? neigh.words : neigh.dWords || 0;
        distance    = halfBracket + 1 - Math.abs(halfBracket + 1 - l + k);
        node.score += words * (tagFactors[neigh.name] || 1) * distance;
      }
    }
    
    // Title influence linearly decays
    node.score = node.score * (titleFound ? (j-i) / titleFound : 1) / denominator;
    info.scores.push(node.score);
  }
  /**
   * Nodes that directly contain text have meaningful scores.
   * We need to calculate the average score of the nodes that contain other nodes.
   * The average is calculated as 
   *    sum(Si) / T
   * where:
   *    Si is the score if the i-th descendant node. We count all descendants, not just children.
   *    T  is the total number of nodes within this node. 
  **/
  (function score(node){
    var child, i = 0, total = 0;
    while(child = node.children[i++]){
      if(child.type === 'tag'){
        total += child.score;
        if( util.isArray(child.children) ){
          total += score(child);
        }
      }
    }
    node.avgScore = (total + node.score) / ((node.nodes || 0) + 1);
    return total;
  })(bodyNode);

  /**
   * HIGH LEVEL FILTER
   *
   * Now that we have assigned scores, we need to get to the node that contains
   * the meat of the content.
   *
   * We do this by using several heuristics:
   *   - The location of the title
   *   - The product of words with the calculated score
   *   - The longest word sequence compared to the height of the node
   *
  **/
  var winner;
  (function hfilter(parent){
    var decisive, metaScore, candidate, runnerup, node, i=0;
    
    winner = parent;
    
    // Parents with height < 1 contain only text nodes.
    // It's better to select a larger portion of the text and leave the rest to the low level filter.
    if(parent.height < 3 || !util.isArray(parent.children) || parent.children.length < 1){
      return;
    }
    // If there's a single child in the node, we select that one as the candidate.
    else if(parent.children.length === 1){
      candidate = parent.children[0];
    }
    else {
      while(node = parent.children[i++]){
        if(node.type !== 'tag' || node.words === 0){
          continue;
        }
        
        metaScore = (node.avgScore || 0) * node.words / ((node.aWords + 3)/2 + (node.lis || 1)/2);
        
        if(!candidate){
          (candidate = node).metaScore = metaScore;
        }
        else if(candidate.containsTitle){
          if(!runnerup || metaScore > runnerup.metaScore){
            (runnerup = node).metaScore = metaScore;
          }
        }
        else if(node.containsTitle || metaScore > candidate.metaScore){
          runnerup = candidate;
          (candidate = node).metaScore = metaScore;
        }
        else if(!runnerup || metaScore > runnerup.metaScore){
          (runnerup = node).metaScore = metaScore;
        }
      }
    }
    
    // If there's no candidate or candidate does not contain the title but the parent does - we stop at the parent.
    if(!candidate || candidate.height < 2 || (parent.containsTitle && !candidate.containsTitle && parent.height < 6)) {
      return;
    }

    // There's a runnerup, check if the candidate is decisive enough
    if(runnerup && runnerup.height !== undefined) {
      // If the runnerup's height is bigger than its longest word sequence, it's ok
      

      // When the height of the candidates is too big, we are more certain in the decisiveness.
      // We decrease the thresholds by multiplying them with hlog.
      var decisive = runnerup.height >= runnerup.longest;
      var hlog = 1 - (Math.log((candidate.height + runnerup.height / 2)) / Math.log(2) - 1) / 10;
      var cmeta = candidate.metaScore, rmeta = runnerup.metaScore, cw = candidate.words, rw = runnerup.words, cavg = candidate.avgScore, ravg = runnerup.avgScore;
      
      if(titleNode){
        decisive = decisive || cw / parent.words > maxWordRatioTitle * hlog;
        decisive = decisive || cavg / ravg > scoreRatioTitle * hlog;
        decisive = decisive || cmeta / rmeta > metaScoreRatioTitle * hlog;
        // We put the min ratio on the power of (log100(parent.words)) because there can be a case where
        // there is an absolutely humongous comment thread after an article.
        decisive = decisive && cw / parent.words > Math.pow(minWordRatioTitle, Math.floor(Math.log(parent.words) / Math.log(100)));
      }
      else {
        // A different set of heuristics for pages with no identifyable title
        decisive = decisive || cw / parent.words > maxWordRatio * hlog;
        decisive = decisive || cavg / ravg > scoreRatio * hlog;
        decisive = decisive || cmeta / rmeta > metaScoreRatio * hlog;
        decisive = decisive && cw / parent.words > Math.pow(minWordRatio, Math.floor(Math.log(parent.words) / Math.log(100)));
      }
      if(!decisive){
        return;
      }
    }

    // The winner has to have children. 
    // We are never selecting a single text node as the winner.
    if(candidate.children && candidate.children.length){
      winner = candidate;      
    }
    hfilter(candidate);
  })(bodyNode);

  /**
   * LOW LEVEL FILTER - Filters out the cruft that happens to be in the same node as the main text.
   * First we calculate:
   *  - The average score of all nodes in the winner node
   *  - The number of text-containing nodes 
  **/
  (function textnodes(node){
    node.textNodes = 0;
    node.children.forEach(function(child){
      if(child.type === 'text'){
        node.textNodes += 1;
      }
      else if(child.type === 'tag'){
        util.isArray(child.children) && textnodes(child);
        node.textNodes += (child.textNodes || 0);
      }
    });
  })(winner);
  
  /**
   * LOW LEVEL FILTER - If the winner contains relatively few direct children, the content is probably in one of them.
   * First we calculate:
   *  - The average score of all nodes in the winner node
   *  - The number of text-containing nodes 
  **/
  var wnode, rnode;
  while(winner.children.length / winner.textNodes < 0.1){
    wnode = rnode = null;
    winner.children.forEach(function(child){
      if(child.words/winner.words < 0.05 || child.words < 2){
        return;
      }
      if(!wnode || (child.avgScore || child.score) > (wnode.avgScore || wnode.score)){
        rnode = wnode;
        wnode = child;
      }
      else if(!rnode || (child.avgScore || child.score) > (rnode.avgScore || rnode.score)){
        rnode = child;
      }
    });

    if(wnode && (!rnode || (wnode.avgScore || wnode.score) / (rnode.avgScore || rnode.score) > 4)){    
      winner.children.forEach(function(child){
        if(child !== wnode){
          child.ignored = true;
        }
      });
    }
    winner = wnode;
  }

  var trend = 0, intext = false, ignore = false;
  var avgScore = winner.avgScore, ignorestack = [];
  
  (function lfilter(node, parent, index){
    var next, ignoreAtThisLevel = false, ix = index;
    
    if(node.height > node.longest){
      node.ignored = true;
    }
    
    if(node.score > avgScore){
      trend = (trend < 0) ? 0 : trend + 1;
    }
    // When the text is ending we usually have series of low scored tags (social links, comment scaffolding)
    else if(node.score / avgScore < 0.5) {
      trend = (trend > 0) ? 0 : trend - 1;
    }
    
    if(!intext && trend > 2){
      intext = true;
    }
    else if(!ignore && intext && trend < -2){
      ignoreAtThisLevel = ignore = true;
      intext = false;
      while(next = parent.children[++ix]){
        if(next.avgScore / avgScore > 0.25){
          ignoreAtThisLevel = ignore = false;
          intext = true;
          trend = 0;
          break;
        }
      }
    }
    if(ignore){
      node.ignored = true;
      ignorestack.push(node);
    }
    if( node.words === 0 ){
      node.ignored = true;
    }
    
    util.isArray(node.children) && node.children.forEach(function(child, i){
      var ch, c, ix = index;
      
      if(child.type !== 'tag'){
        return;
      }
      
      // Ignore happened in a subnode. Look at the next siblings to see
      if( lfilter(child, node, i) && (ch = parent && parent.children) ){
        while(c = ch[++ix]){
          if(c && c.avgScore / avgScore > 0.25){
            trend  = 0;
            ignore = false;
            intext = true;
            ignorestack.forEach(function(node){
              delete node.ignored;
            });
            ignorestack.length = 0;
            return;
          }
        }
        ignoreAtThisLevel = true;
      }
    });
    
    // It is often tha case that we reach the end of the text (linearly) while still inside a
    // node that contains links or similar stuff and we end up ignoring only the second part of that node.
    if(node.height >= node.longest){
      node.ignored = true;
    }
    
    // Ignore nodes that are consisted entirely of linked text, their height is > 1 and they contain multiple words. 
    // These are most likely menus and tebles of contents.
    if(node.height && node.aWords === node.words && (node.words > node.longest || node.words <= node.nodes) ){
      node.ignored = true;
    }
    
    return ignoreAtThisLevel;
  })(winner);
  
  info.height   = bodyNode.height;
  info.words    = bodyNode.words;
  info.nodes    = bodyNode.nodes;
  info.links    = bodyNode.links;
  info.aWords   = bodyNode.aWords;
  info.longest  = bodyNode.longest;
  
  return {
    info:     info,
    dom:      bodyNode,
    textNode: winner,
    content:  getFormattedText(winner)
  };
}

exports.analyze          = analyze;
exports.printTree        = printTree;
exports.getFormattedText = getFormattedText;