import { registerHooks } from 'node:module';
if (process.env.WHATSAPP_SYNTHETIC_TEST !== '1') throw new Error('Synthetic import hook requires explicit test mode');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@whiskeysockets/baileys') {
      return { url: new URL('./synthetic_baileys.mjs', import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
