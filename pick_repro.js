const { JSDOM } = require('jsdom');
const fs = require('fs');

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="stimulus-pane"></div><div id="question-pane"></div>
  <table><tr><td id="cell"><span class="flagicon"><img></span> <a href="/wiki/Alex_Ferguson">Alex Ferguson</a></td></tr></table>
</body></html>`, { url: 'http://localhost/', runScripts: 'dangerously' });
const { window } = dom;
const { document } = window;

window.CSS = window.CSS || {};
window.CSS.escape = window.CSS.escape || ((s) => s.replace(/([^\w-])/g, '\\$1'));
window.StudySession = { state: {} };

document.caretRangeFromPoint = (x, y) => {
  const a = document.querySelector('a');
  const r = document.createRange();
  r.setStart(a.firstChild, 0);
  r.setEnd(a.firstChild, 0);
  return r;
};

const code = fs.readFileSync('/sessions/exciting-charming-franklin/mnt/user_study_website/app/study.js', 'utf8');
try {
  window.eval(code);
} catch (e) {
  console.log('eval error:', e.message);
}

console.log('startPicking defined:', typeof window.startPicking);

const frameLike = { contentDocument: document };
const cell = document.getElementById('cell');

window.startPicking(frameLike, 'text', (value, label) => {
  console.log('hop0 onPick:', label);
});
for (let i = 0; i < 5; i++) {
  cell.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 10 + i, clientY: 10 }));
}
cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 12, clientY: 10 }));

console.log('--- after hop0 click ---');
console.log(cell.innerHTML);

window.startPicking(frameLike, 'text', (value, label) => {
  console.log('hop1 onPick:', label);
});
for (let i = 0; i < 5; i++) {
  cell.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 10 + i, clientY: 10 }));
}
cell.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 12, clientY: 10 }));

console.log('--- after hop1 click ---');
console.log(cell.innerHTML);
