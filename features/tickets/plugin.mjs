import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
  async register(app, _nc, _manager, _opts) {
    const { default: express } = await import('express');
    const frontendDist = path.join(__dirname, 'frontend-dist');
    if (fs.existsSync(frontendDist)) {
      app.use('/features/tickets', express.static(frontendDist));
    }
    console.log('[tickets feature] Plugin registered');
  },
};
