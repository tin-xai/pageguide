const { JSDOM } = require('jsdom');
const dom = new JSDOM(`<!doctype html><html><body></body></html>`, { runScripts: 'dangerously' });
const { window } = dom;
window.eval('function foo(){return 42;} const bar = 1;');
console.log('foo:', typeof window.foo, 'bar:', typeof window.bar);
