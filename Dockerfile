# Sirve el juego ya compilado (index.html + js/app.min.js) como web estática.
# Firebase y el TURN de Cloudflare no van aquí: el navegador se conecta a ellos directamente.
#   docker compose up -d   ->  http://localhost:8080
FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html
RUN rm -rf /usr/share/nginx/html/docker
