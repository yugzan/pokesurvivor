# Daño doble cerca del punto de salida (rejilla de enemigos)

**Qué pasaba:** cerca del punto de salida (0,0), los ataques de área golpeaban
dos veces al mismo enemigo. Todas las partidas empiezan ahí, así que el principio
de cada partida era más fácil de lo previsto y los números de daño no cuadraban
con el resto del mapa.

## Causa

`G.EnemyMgr` (`js/entities/enemy.js`) reparte los enemigos en una rejilla de
celdas de 52 px para buscarlos rápido. La clave de cada celda era:

```js
function key(cx, cy) { return cx * 73856093 ^ cy * 19349663; }
```

Con números negativos, el XOR da la misma clave para celdas simétricas respecto
al origen: `key(1,1) === key(-1,-1)`, `key(1,-1) === key(-1,1)`, `key(2,2) === key(-2,-2)`...
(pasa cuando `cx` y `cy` tienen el mismo número de ceros al final en binario).
Entre -200 y 200 celdas había **26.688 claves repetidas** de 160.801.

Las dos celdas comparten cubo, y `queryCircle` recorre las celdas alrededor del
ataque: si ese recorrido incluye las dos celdas gemelas (sólo pasa cerca del
origen, porque están a ambos lados de él), lee el mismo cubo dos veces y devuelve
cada enemigo **dos veces**. Lo que usa `queryCircle` sin descartar repetidos
golpea dos veces: cuerpo a cuerpo, rayos, auras, embestidas y explosiones. `separate()` (que aparta
a los enemigos entre sí) también los contaba dos veces.

Lejos del origen las celdas gemelas nunca caen en el mismo recorrido, así que el
fallo sólo se nota al empezar.

## Arreglo

Una clave que no se repite:

```js
function key(cx, cy) { return cx * 1048576 + cy; }
```

Es exacta mientras `|cy| < 2^19` celdas (unos 27 millones de px desde el origen),
muy lejos de donde llega una partida. Mismo rendimiento: sigue siendo un número.

## Comprobación

Un enemigo quieto y sin moverse, el jugador al lado, 3 s de ataque, mismas
condiciones en cuatro sitios del mapa (daño total al enemigo):

| Movimiento | Junto al origen (40,40) | Lejos (20040,20040) | Origen, lado negativo (-40,-40) | Lejos (20404,20404) |
|---|---|---|---|---|
| Placaje, antes | **192** | 96 | 96 | 96 |
| Placaje, ahora | 96 | 96 | 96 | 96 |
| Gigadrenado, antes | **108** | 54 | 54 | 54 |
| Gigadrenado, ahora | 54 | 54 | 54 | 54 |
| Picadura, antes | **182** | 91 | 91 | 91 |
| Picadura, ahora | 91 | 91 | 91 | 91 |

El número de golpes es el mismo en todos los casos (6 o 7): antes cada golpe
contaba dos veces junto al origen.

## Efecto en el juego

- Los primeros segundos de cada partida (en el área de salida) los ataques de
  área hacen ahora el daño normal, no el doble. El principio puede notarse un poco
  más difícil, pero es el daño que siempre se quiso.
- Los proyectiles y el contacto enemigo → jugador también usan `queryCircle`,
  pero ya descartaban al enemigo repetido (los proyectiles con `p.hits` / `p.hitLog`
  por enemigo, el contacto con `touchCd`), así que su daño no cambia.
- Novedades: entrada `fix` del 2026-10-19 en `js/data/changelog.js`.

## Archivos

- `js/entities/enemy.js`: la función `key` de la rejilla.
- `js/data/changelog.js`, `js/data/lang-zh-Hant.js`: la novedad y su título en chino.
- Este documento.

No incluye `index.html` ni `js/app.min.js`: se regeneran con `node tools/build.js`
al publicar.
