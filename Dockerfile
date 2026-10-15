# Sirve el juego ya compilado (index.html + js/app.min.js) como web estática.
# Firebase y el TURN de Cloudflare no van aquí: el navegador se conecta a ellos directamente.
# A cuáles, se elige en .env (ver .env.example) sin volver a compilar.
#   docker compose up -d   ->  http://localhost:8090
FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html
RUN rm -rf /usr/share/nginx/html/docker
# Al arrancar: config.js con los datos del .env (Firebase, dominios, TURN)
COPY --chmod=755 docker/config.sh /docker-entrypoint.d/40-pokesurvivor-config.sh
