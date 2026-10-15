/* config.js — datos de conexión que cambian según dónde se publica el juego.
 * En la web oficial queda en null y se usan los de siempre (js/core/firebase-config.js).
 * En Docker lo reescribe docker/config.sh al arrancar, con las variables del .env:
 *   window.PS_CONFIG = { firebase: {...} | null, hosts: ['mi-dominio.com'], turnUrl: 'https://...' | '' };
 */
window.PS_CONFIG = null;
