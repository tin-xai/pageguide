function parseMarkdown(text) {
  let result = text;
  
  // Bold
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  
  // Bullet lists (- item or * item at start of line)
  result = result.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
  
  // Collapse spaces/newlines between list items
  result = result.replace(/<\/li>\s*<li>/g, '</li><li>');
  
  // Wrap consecutive <li> elements in <ul>
  result = result.replace(/(<li>[\s\S]*?<\/li>)+/g, '<ul>$&</ul>');
  
  // Italic with *text* (single asterisks, not part of **)
  // Stop at newline so it doesn't span multiple paragraphs/list items
  result = result.replace(/(?<!\*)\*([^*^\n]+)\*(?!\*)/g, '<em>$1</em>');
  
  // Line breaks
  result = result.replace(/\n\n/g, '</p><p>');
  result = result.replace(/\n/g, '<br>');
  
  result = result.replace(/<p><\/p>/g, '');
  result = result.replace(/<br><br>/g, '</p><p>');
  
  if (!result.startsWith('<h') && !result.startsWith('<ul') && !result.startsWith('<pre') && !result.startsWith('<p')) {
    result = '<p>' + result + '</p>';
  }
  
  return result;
}

const text = `These include:
* Winona Ryder as Joyce Byers
* Millie Bobby Brown as Eleven
* Sadie Sink as Max Mayfield
* Natalia Dyer as Nancy Wheeler
* Maya Hawke as Robin Buckley
* Priah Ferguson as Erica Sinclair

* Cara Buono as Karen Wheeler`;

console.log(parseMarkdown(text));
