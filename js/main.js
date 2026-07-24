/* ============================================================
   PontoBots v2 — main.js
   Bootstrap da aplicação.
   ============================================================ */

import { initUI } from './ui.js';

// Esperar DOM pronto
function bootstrap() {
  initUI();
  console.log('%c⟡ PontoBots v2 inicializado', 'color:#0ff;font-weight:600;font-size:14px;');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
