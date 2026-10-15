# PokéSurvivor · Agent edition

> **This branch of PokéSurvivor is meant mainly for AI agents to play.**
> The game page exposes a remote **MCP** server, so any MCP client (Claude Code,
> Claude Desktop, Codex…) can pair with a run open in someone's browser, read the
> battle state, pick level-up cards and steer the character. People can still play
> normally; runs with AI go on the leaderboard, marked and kept apart from your own.
>
> 這個版本主要是給 AI agent 玩的：網站提供遠端 MCP，agent 配對後就能讀戰況、選卡、走位。人類照樣可以玩。

## Quick start (agents)

1. Open the game, go to **Settings > AI** and turn on the AI connection. You get a
   **6-character pairing code** (valid for 10 minutes) and the MCP address
   (`https://<site>/mcp`).
2. Add that address as a remote MCP server (Streamable HTTP) in your client, e.g.
   Claude Code: `claude mcp add --transport http pokesurvivor https://<site>/mcp`.
3. Start a run and ask your agent to call `pair` with the code.

## Tools

| Tool | What it does |
|---|---|
| `pair(code, client_name?)` | Bind this MCP session to the run that shows the code |
| `get_state()` | Battle state: phase, time, player (HP, level, moves, stats), nearest enemies and pickups relative to the player |
| `get_choice()` | The open choice screen (level-up / item / bond cards), or null |
| `wait_for_choice(timeout_s)` | Wait (up to 60 s) until a new choice screen opens |
| `choose(index)` | Pick a card |
| `reroll()` | Reroll the level-up cards (if rerolls remain) |
| `set_autopilot(mode, weights?)` | Built-in per-frame movement: `off`, `kite`, `retreat`, `collect_xp`, `hunt_boss` |
| `move(dx, dy, ms)` | Short manual steering override (50–3000 ms) |
| `release()` | Stop moving and hand control back to the player |

Suggested loop: `pair` → `set_autopilot("kite")` → repeat `wait_for_choice` → `choose`,
checking `get_state` between choices to adjust the autopilot. MCP calls are too slow
for frame-by-frame control, so leave movement to the autopilot. Card texts are in Spanish.

## Jev tools

With your own [TypeSafe](https://typesafe.ai) key, the relay can also ask **Jev**
(TypeSafe's System One model) for probabilities. Get a key at
https://console.typesafe.ai/keys.

| Tool | What it does |
|---|---|
| `evaluate_choices()` | Jev's probability for each card on the open screen, its pick and confidence (plus the chance a reroll is better); also drawn over the cards on the player's screen |
| `should_reroll()` | Probability that the current level-up cards are all poor and a reroll is better |
| `suggest_strategy(apply?)` | Autopilot mode Jev recommends now (`kite`, `retreat`, `collect_xp`, `hunt_boss`); `apply: true` switches to it |
| `auto_play(enabled, min_confidence?, strategy_every_s?)` | Server-side loop that plays with Jev alone: picks cards when confidence ≥ `min_confidence` (default 0.35; otherwise it only shows the probabilities), rerolls poor sets, updates the autopilot every `strategy_every_s` s (default 4). Stops with `auto_play(false)`, `release()` or when the session ends |
| `auto_play_status()` | Whether `auto_play` runs, choices made, last error |

Send the key as the `X-Jev-Key` header in your MCP client config, e.g. Claude Code:
`claude mcp add --transport http pokesurvivor https://<site>/mcp --header "X-Jev-Key: <key>"`.
Clients that cannot set headers can pass `jev_key` to each Jev tool (the header wins).

Privacy: the key is only forwarded to TypeSafe with each Jev call; it is never stored
or logged (`auto_play` keeps it in memory while its loop runs). Leaderboard: using only
`evaluate_choices` / `should_reroll` / `suggest_strategy` while you play yourself marks the run 🧠;
`auto_play` or the agent picking/moving marks it 🤖.

## Leaderboard

Runs with AI count, but each player gets a separate AI record (it never replaces
your own): 🧠 = AI-assisted (AI advice, you played), 🤖 = played by AI (the agent
picked cards or moved). "Hide AI" shows only runs played by people. The mark is
reported by the game itself, like the rest of the score.

## Running it yourself

`docker compose up -d` starts the site (`web`, nginx) and the relay (`mcp`, Node, in
`mcp/`); nginx forwards `/mcp` and `/agent/` to it. Relay tests: `cd mcp && npm test`.

---

# PokéSurvivor · Mundo Misterioso

Bullet-heaven con Pokémon al estilo de Survivor.io y Megabonk, con sprites de
*Pokémon Mundo Misterioso*, capa roguelike, **966 Pokémon de las 9 generaciones**,
shinies y gacha por región. Música y efectos compuestos para el juego.

HTML + CSS + JavaScript vanilla sobre Canvas 2D. Sin build, sin dependencias y
**todo local**: no necesita internet para jugar.

> **Aviso sobre criptomonedas / Crypto disclaimer**
>
> PokéSurvivor **no tiene ninguna criptomoneda, token ni NFT oficial**, y yo no
> he creado ninguno. Cualquier token que use el nombre del juego lo han creado
> terceros. **No me hago cargo de ninguna compra, venta o inversión** que hagas
> con ellos y nada de lo que hay aquí es una recomendación de inversión. El
> juego es gratis y lo seguirá siendo.
>
> PokéSurvivor has **no official cryptocurrency, token or NFT**, and I have not
> created any. Any token using the game's name was created by third parties.
> **I take no responsibility for any purchase, sale or investment** you make
> with them, and nothing here is investment advice. The game is free and will
> stay free.

## Jugar

Doble clic en `index.html`. Crea una cuenta o entra como invitado, haz el test
de personalidad y a la mazmorra.

| Tecla | Acción |
|---|---|
| `W` `A` `S` `D` / flechas | Moverse |
| `1` `2` `3` `4` | Elegir el movimiento activo |
| `Q` / `E` | Ciclar movimientos |
| `Esc` / `P` | Pausa |

**En móvil o tablet** (en horizontal): pon el dedo en cualquier sitio y arrastra
para moverte (el joystick aparece donde tocas), toca un ataque de abajo para
cambiarlo y el botón de arriba a la derecha para pausar. Se puede instalar como
app ("Añadir a pantalla de inicio"). En **Ajustes** hay sonido, calidad gráfica
(con modo automático), números de daño, menos sacudidas, FPS y la cuenta.

El Pokémon ataca solo con el movimiento activo (o con todos los de un
**vínculo**: cada legendario vencido deja fusionar movimientos para lanzarlos a
la vez desde un solo hueco, hasta 4). Las rocas, cofres y la hierba
alta se rompen; las paredes y los árboles bloquean los disparos enemigos; el
agua frena y la lava quema (también a los enemigos).

En el mapa hay **altares de poder**, **manantiales** que curan, **cofres con
candado** (quédate a su lado unos segundos) y **trampas** que también dañan a
los enemigos. A veces se abre una **grieta**: entra y lucharás contra un
**legendario** en una arena aparte.

Hay **tabla de tipos** (un Rayo Burbuja le quita más a un Charmander) y,
de vez en cuando, **climas** (sol, lluvia, arena, nieve, niebla) que potencian
unos tipos y debilitan otros.

Cada día hay **misiones** (y semanales) que dan tickets y monedas; los
**logros** dan medallas y títulos, y tu **perfil** enseña tus 3 Pokémon
favoritos, tus marcas y tus medallas. En las runs encuentras **objetos** (Restos,
Cinta Elección...) y tus movimientos **evolucionan** al máximo nivel. Los
enemigos tienen personalidad: curan, ponen escudos, llaman a su manada o atacan
con aviso en el suelo.

Las **mejoras** son de cada Pokémon. El **gacha** va con **tickets** que se
ganan jugando (×1 de algunos Pokémon, ×10 de jefes y legendarios), y se tira
en una tragaperras pixel art.

Cada enemigo tiene 1/4096 de salir **shiny**: brilla, una flecha en el borde de
la pantalla te dice dónde está, y si lo derrotas te lo quedas. En el gacha sale
shiny 1 de cada 100 tiradas. En la colección eliges tu compañero en versión
normal o shiny.

La música suena tras el primer clic (los navegadores no dejan reproducir sonido
antes). Volumen y silencio: botón del altavoz arriba a la derecha, o en la pausa.

El guardado vive en el `localStorage` del navegador: si borras los datos del
sitio, se pierde.

En `videos/` hay grabaciones del juego (con su música): un combate contra un
jefe, la captura de un shiny salvaje y un shiny en el gacha.

## Guardado en la nube y publicación

- **Base de datos (Firebase):** cuentas con nombre + contraseña o Google, y la
  partida se sigue en cualquier ordenador. Pasos en [docs/FIREBASE.md](docs/FIREBASE.md).
  Sin configurar, el juego guarda sólo en el navegador, como antes.
- **Jugar con amigos (hasta 4) y ranking:** con cuenta en la nube, menú
  **Amigos** (añadir por apodo, invitar a tu sala) y **Ranking** (tiempo
  aguantado: solo o grupo, de hoy a histórico, amigos, por Pokémon).
- **Publicar gratis en GitHub Pages:** [docs/PUBLICAR.md](docs/PUBLICAR.md).
- Si se juega en dos ordenadores a la vez o sin conexión, las partidas se
  **fusionan**: las colecciones se unen (nunca se pierde un Pokémon ni un
  shiny), mejoras y estadísticas se quedan con el máximo, y monedas y
  compañero con la versión más reciente. Los cambios de otro ordenador llegan
  en directo.

## Licencia

Código bajo [PolyForm Noncommercial 1.0.0](LICENSE-NONCOMMERCIAL.md) desde el
14-10-2026: se puede usar, estudiar y modificar, pero **no con fines
comerciales** (ni vender el juego ni cobrar nada dentro de él). Las versiones
hasta el commit `b297089` se publicaron bajo MIT. Los sprites (CC BY-NC 4.0),
la fuente (OFL) y las marcas de Pokémon tienen sus propias condiciones: ver
[LICENSE](LICENSE) y [CREDITS.md](CREDITS.md). Proyecto de fan sin ánimo de
lucro.

**La única web oficial es [pokesurvivor.com](https://pokesurvivor.com).** El
juego es y será gratis: si alguien te pide pagar, no somos nosotros.

## Estructura

```
index.html              pantallas + orden de carga
css/style.css           interfaz estilo Mundo Misterioso
assets/pokemon/{dex}/   hojas de sprites PMD (Idle, Walk, Attack, Shoot, Charge, Hurt, Faint)
assets/pokemon/{dex}/s/ las mismas en versión shiny
assets/fonts/           Pixelify Sans (OFL) y su versión con números redibujados (tools/make_font.py)
js/
  net/      social (apodo, amigos, salas), net (WebRTC + relé),
            coop (partida en grupo), ranking
  core/     util, db (guardado), audio (sintetizador + efectos), input,
            sprites (animador PMD), camera
  data/     pokedex*, sprites-meta*, moves, starters (+ test), enemies,
            upgrades, music (partituras)
  world/    tiles (pixel art en código), world (terreno, objetos, colisiones)
  entities/ player, enemy, projectile, pickup, fx
  systems/  combat, spawner, levelup, gacha
  ui/       icons (pixel art), ui, hud, login, test, menu, gacha-ui, run-ui,
            social-ui, ranking-ui
  game.js   flujo y bucle principal
tools/      scripts que regeneran los ficheros marcados con *
```

`*` = generado. Para rehacerlos (necesita Python 3 + Pillow e internet, sólo esa vez):

```
python tools/fetch_sprites.py    # sprites normal y shiny + js/data/sprites-meta.js
                                 # (~20 min; se puede cortar y relanzar: usa tools/cache/)
python tools/fetch_pokedex.py    # js/data/pokedex.js
python tools/fetch_credits.py    # CREDITS.md
```

## Notas de implementación

- **Sprites PMD.** Columnas = fotogramas, filas = 8 direcciones (Down, DownRight,
  Right, UpRight, Up, UpLeft, Left, DownLeft — verificado con los `-Offsets.png`).
  Cada animación tiene su propio tamaño de fotograma, así que se alinean por el
  **ancla al suelo** sacada del `-Shadow.png`; sin eso el sprite saltaría al atacar.
- **Coordenadas.** `(x, y)` de una entidad son sus **pies**. Las colisiones
  ocurren en el plano del suelo; los proyectiles vuelan en ese plano y se dibujan
  elevados con su sombra debajo.
- **Mundo.** Chunks de 16×16 tiles: los *datos* (terreno, objetos) son baratos y
  se generan siempre; la *imagen* se hornea a resolución de arte escribiendo en un
  `ImageData` (~4 ms por chunk en Chrome) y sólo para los visibles.
- **Rendimiento.** Rejilla espacial de enemigos reconstruida cada frame. Con 420
  enemigos, simulación + render completo ≈ 3 ms por frame en Chrome.
- **Metadatos en `.js`, no `.json`**, porque `fetch()` está bloqueado en `file://`.
- **Shiny.** Los shiny de SpriteCollab son el mismo dibujo con otra paleta; están
  en `s/` y sólo 30 tienen geometría distinta (campo `sa` en los metadatos).
  Las hojas se guardan como PNG con paleta exacta: misma imagen, la mitad de peso.
- **Audio.** Sintetizador Web Audio con planificador anticipado (programa las
  notas 150 ms por delante) y reverb por convolución con un impulso generado.
  Las partituras están en `js/data/music.js` en un formato de texto propio.
  Los efectos tienen separación mínima entre repeticiones y un tope de voces,
  para que 400 enemigos golpeados a la vez no saturen.
- **Iconos.** Mapas de caracteres convertidos a canvas y data URLs; siempre a
  múltiplos enteros de su tamaño para que el píxel quede limpio.

## Créditos y licencia

Sprites de [SpriteCollab](https://github.com/PMDCollab/SpriteCollab) bajo
**CC BY-NC 4.0** — uso **no comercial** y con atribución; la lista de artistas
está en [`CREDITS.md`](CREDITS.md). Pokémon es propiedad de Nintendo, Creatures
Inc. y GAME FREAK. Proyecto de fan sin ánimo de lucro.
