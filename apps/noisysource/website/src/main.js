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
