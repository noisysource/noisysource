import '@fontsource/oxanium/500.css';
import '@fontsource/jetbrains-mono/400.css';
import './style.css';
import { startIntro } from './intro.js';

const go = () => startIntro({
  canvas: document.getElementById('stage'),
  flash: document.getElementById('flash'),
  tagline: document.getElementById('tagline'),
});

// The canvas draws with Oxanium, so wait for it (but never hang on it).
Promise.race([
  Promise.all([document.fonts.load('500 64px Oxanium', 'noısy source i'), document.fonts.load('400 16px "JetBrains Mono"')]),
  new Promise((r) => setTimeout(r, 2500)),
]).then(go, go);

// For whoever opens the console.
console.log(
  '%cfor (const i of intelligence) combine(human, artificial);\n%c// you looked closer. so does it. try typing its name.',
  'font: 13px "JetBrains Mono", monospace; color: #4a7bff',
  'font: 12px "JetBrains Mono", monospace; color: #6b7590',
);

