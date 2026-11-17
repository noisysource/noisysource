import './style.css';
import { startCosmos } from './cosmos.js';
import { startTypewriter } from './typewriter.js';

startCosmos({
  canvas: document.getElementById('brain'),
  status: document.getElementById('status'),
  flash: document.getElementById('flash'),
  halo: document.querySelector('.halo'),
});
startTypewriter(document.getElementById('msg'));
