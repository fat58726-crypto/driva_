const { Bot } = require("grammy");
const { Pool } = require("pg");
const express = require("express");

// ============================================================
// CONFIGURACIÓN
// ============================================================

const token = process.env.BOT_TOKEN;
const databaseUrl = process.env.DATABASE_URL;
const mapKey = process.env.MAP_KEY;

if (!token) {
  console.error("ERROR: no llegó la variable BOT_TOKEN al contenedor.");
  process.exit(1);
}

if (!databaseUrl) {
  console.error("ERROR: no llegó la variable DATABASE_URL al contenedor.");
  process.exit(1);
}

if (!mapKey) {
  console.error("ERROR: no llegó la variable MAP_KEY al contenedor.");
  process.exit(1);
}

// ============================================================
// BASE DE DATOS
// ============================================================

const pool = new Pool({
  connectionString: databaseUrl
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conductoras (
      telegram_id BIGINT PRIMARY KEY,
      nombre TEXT,
      placas TEXT,
      tipo_sangre TEXT,
      contacto_nombre TEXT,
      contacto_telefono TEXT,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS turnos (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'activo',
      inicio TIMESTAMP DEFAULT NOW(),
      fin TIMESTAMP,
      ultima_lat DOUBLE PRECISION,
      ultima_lng DOUBLE PRECISION,
      ultima_actualizacion TIMESTAMP,
      nivel_alerta INTEGER DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS grupos_alerta (
      chat_id BIGINT PRIMARY KEY,
      nombre TEXT
    );
  `);

  console.log(
    "Tablas listas: conductoras, turnos, grupos_alerta"
  );
}

// ============================================================
// BOT
// ============================================================

const bot = new Bot(token);

// Estado temporal del registro
const registrosEnCurso = new Map();

const PASOS = [
  "nombre",
  "placas",
  "tipo_sangre",
  "contacto"
];

// ============================================================
// START
// ============================================================

bot.command("start", async (ctx) => {
  await ctx.reply(
    "¡Hola! Soy Driva 🚗\n\n" +
    "Comandos disponibles:\n" +
    "/registro - Registrarte como conductora\n" +
    "/perfil - Ver tus datos guardados\n" +
    "/turno - Iniciar tu turno\n" +
    "/fin - Terminar tu turno\n" +
    "/cancelar - Cancelar un registro en curso\n\n" +
    "Dentro del grupo: /activar_alertas para que reciba los avisos de seguridad."
  );
});

// ============================================================
// REGISTRO
// ============================================================

bot.command("registro", async (ctx) => {
  const userId = ctx.from.id;

  registrosEnCurso.set(userId, {
    paso: 0,
    datos: {}
  });

  await ctx.reply(
    "Vamos a registrarte. Puedes escribir /cancelar en cualquier momento.\n\n" +
    "¿Cuál es tu nombre completo?"
  );
});

// ============================================================
// CANCELAR REGISTRO
// ============================================================

bot.command("cancelar", async (ctx) => {
  const userId = ctx.from.id;

  if (registrosEnCurso.has(userId)) {
    registrosEnCurso.delete(userId);
    await ctx.reply("Registro cancelado.");
  } else {
    await ctx.reply("No tienes ningún registro en curso.");
  }
});

// ============================================================
// PERFIL
// ============================================================

bot.command("perfil", async (ctx) => {
  const userId = ctx.from.id;

  try {
    const result = await pool.query(
      `
      SELECT
        nombre,
        placas,
        tipo_sangre,
        contacto_nombre,
        contacto_telefono
      FROM conductoras
      WHERE telegram_id = $1
      `,
      [userId]
    );

    if (result.rows.length === 0) {
      await ctx.reply(
        "Todavía no estás registrada. Escribe /registro para empezar."
      );
      return;
    }

    const c = result.rows[0];

    await ctx.reply(
      `Tu perfil:\n\n` +
      `Nombre: ${c.nombre}\n` +
      `Placas: ${c.placas}\n` +
      `Tipo de sangre: ${c.tipo_sangre}\n` +
      `Contacto de confianza: ${c.contacto_nombre} (${c.contacto_telefono})`
    );

  } catch (err) {
    console.error("Error al leer perfil:", err);

    await ctx.reply(
      "Hubo un problema al buscar tu perfil. Intenta de nuevo en un momento."
    );
  }
});

// ============================================================
// COMPROBAR SI ESTÁ REGISTRADA
// ============================================================

async function estaRegistrada(telegramId) {
  const r = await pool.query(
    "SELECT 1 FROM conductoras WHERE telegram_id = $1",
    [telegramId]
  );

  return r.rows.length > 0;
}

// ============================================================
// BUSCAR TURNO ACTIVO
// ============================================================

async function turnoActivo(telegramId) {
  const r = await pool.query(
    `
    SELECT id
    FROM turnos
    WHERE telegram_id = $1
      AND estado = 'activo'
    ORDER BY id DESC
    LIMIT 1
    `,
    [telegramId]
  );

  return r.rows[0] || null;
}

// ============================================================
// INICIAR TURNO
// ============================================================

bot.command("turno", async (ctx) => {
  const userId = ctx.from.id;

  try {
    if (!(await estaRegistrada(userId))) {
      await ctx.reply(
        "Primero necesitas registrarte. Escribe /registro."
      );
      return;
    }

    const activo = await turnoActivo(userId);

    if (activo) {
      await ctx.reply(
        "Ya tienes un turno activo. Escribe /fin cuando termines."
      );
      return;
    }

    await pool.query(
      `
      INSERT INTO turnos (
        telegram_id,
        estado,
        inicio
      )
      VALUES ($1, 'activo', NOW())
      `,
      [userId]
    );

    await ctx.reply(
      "Turno iniciado ✅\n\n" +
      "Ahora comparte tu ubicación en vivo:\n\n" +
      "1. Toca el clip 📎\n" +
      "2. Elige 'Ubicación'\n" +
      "3. Elige 'Compartir ubicación en vivo'\n" +
      "4. Selecciona la duración\n\n" +
      "Cuando termines tu turno, escribe /fin."
    );

  } catch (err) {
    console.error("Error al iniciar turno:", err);

    await ctx.reply(
      "No pude iniciar tu turno. Intenta nuevamente."
    );
  }
});

// ============================================================
// FINALIZAR TURNO
// ============================================================

bot.command("fin", async (ctx) => {
  const userId = ctx.from.id;

  try {
    const activo = await turnoActivo(userId);

    if (!activo) {
      await ctx.reply(
        "No tienes ningún turno activo."
      );
      return;
    }

    await pool.query(
      `
      UPDATE turnos
      SET
        estado = 'finalizado',
        fin = NOW()
      WHERE id = $1
      `,
      [activo.id]
    );

    await ctx.reply(
      "Turno finalizado. Puedes dejar de compartir tu ubicación en vivo. Buen viaje 🚗"
    );

  } catch (err) {
    console.error("Error al finalizar turno:", err);

    await ctx.reply(
      "Hubo un problema al finalizar tu turno."
    );
  }
});

// ============================================================
// ACTIVAR ALERTAS DEL GRUPO
// ============================================================

bot.command("activar_alertas", async (ctx) => {
  if (
    ctx.chat.type !== "group" &&
    ctx.chat.type !== "supergroup"
  ) {
    await ctx.reply(
      "Este comando se usa dentro del grupo, no en privado."
    );
    return;
  }

  try {
    await pool.query(
      `
      INSERT INTO grupos_alerta (
        chat_id,
        nombre
      )
      VALUES ($1, $2)
      ON CONFLICT (chat_id)
      DO UPDATE SET nombre = EXCLUDED.nombre
      `,
      [
        ctx.chat.id,
        ctx.chat.title || "Grupo"
      ]
    );

    await ctx.reply(
      "Listo, este grupo va a recibir las alertas de seguridad."
    );

  } catch (err) {
    console.error("Error al activar alertas:", err);

    await ctx.reply(
      "No pude activar las alertas."
    );
  }
});

// ============================================================
// PROCESAR REGISTRO
// ============================================================

bot.on("message:text", async (ctx) => {
  const userId = ctx.from.id;
  const texto = ctx.message.text.trim();

  if (texto.startsWith("/")) {
    return;
  }

  const estado = registrosEnCurso.get(userId);

  if (!estado) {
    await ctx.reply(
      "No entendí eso. Escribe /registro para registrarte o /perfil para ver tus datos."
    );
    return;
  }

  const pasoActual = PASOS[estado.paso];

  // -------------------------
  // NOMBRE
  // -------------------------

  if (pasoActual === "nombre") {
    estado.datos.nombre = texto;
    estado.paso++;

    await ctx.reply(
      "Perfecto. ¿Cuáles son tus placas?"
    );

    return;
  }

  // -------------------------
  // PLACAS
  // -------------------------

  if (pasoActual === "placas") {
    estado.datos.placas = texto;
    estado.paso++;

    await ctx.reply(
      "¿Cuál es tu tipo de sangre? (ejemplo: O+, A-, etc.)"
    );

    return;
  }

  // -------------------------
  // TIPO DE SANGRE
  // -------------------------

  if (pasoActual === "tipo_sangre") {
    estado.datos.tipo_sangre = texto;
    estado.paso++;

    await ctx.reply(
      "Por último, escribe el nombre y teléfono de tu contacto de confianza, separados por una coma.\n" +
      "Ejemplo: Laura Pérez, 5512345678"
    );

    return;
  }

  // -------------------------
  // CONTACTO
  // -------------------------

  if (pasoActual === "contacto") {
    const partes = texto.split(",");

    if (partes.length < 2) {
      await ctx.reply(
        "Necesito el nombre y el teléfono separados por una coma.\n" +
        "Ejemplo: Laura Pérez, 5512345678"
      );

      return;
    }

    const contactoNombre = partes[0].trim();
    const contactoTelefono = partes
      .slice(1)
      .join(",")
      .trim();

    try {
      await pool.query(
        `
        INSERT INTO conductoras (
          telegram_id,
          nombre,
          placas,
          tipo_sangre,
          contacto_nombre,
          contacto_telefono
        )
        VALUES ($1, $2, $3, $4, $5, $6)

        ON CONFLICT (telegram_id)
        DO UPDATE SET
          nombre = EXCLUDED.nombre,
          placas = EXCLUDED.placas,
          tipo_sangre = EXCLUDED.tipo_sangre,
          contacto_nombre = EXCLUDED.contacto_nombre,
          contacto_telefono = EXCLUDED.contacto_telefono
        `,
        [
          userId,
          estado.datos.nombre,
          estado.datos.placas,
          estado.datos.tipo_sangre,
          contactoNombre,
          contactoTelefono
        ]
      );

      registrosEnCurso.delete(userId);

      await ctx.reply(
        "¡Listo! Quedaste registrada ✅\n\n" +
        "Escribe /perfil para ver tus datos."
      );

    } catch (err) {
      console.error(
        "Error al guardar conductora:",
        err
      );

      await ctx.reply(
        "Hubo un problema al guardar tu registro. Intenta de nuevo con /registro."
      );
    }

    return;
  }
});

// ============================================================
// GUARDAR UBICACIÓN
// ============================================================

async function guardarUbicacion(
  userId,
  lat,
  lng
) {
  try {
    console.log(
      `📍 Intentando guardar ubicación: ${userId} -> ${lat}, ${lng}`
    );

    const activo = await turnoActivo(userId);

    if (!activo) {
      console.log(
        `⚠️ ${userId} mandó ubicación pero no tiene turno activo.`
      );

      return false;
    }

    await pool.query(
      `
      UPDATE turnos
      SET
        ultima_lat = $1,
        ultima_lng = $2,
        ultima_actualizacion = NOW(),
        nivel_alerta = 0
      WHERE id = $3
      `,
      [
        lat,
        lng,
        activo.id
      ]
    );

    console.log(
      `✅ Ubicación guardada correctamente: ${userId} -> ${lat}, ${lng}`
    );

    return true;

  } catch (err) {
    console.error(
      "❌ Error guardando ubicación:",
      err
    );

    return false;
  }
}

// ============================================================
// UBICACIÓN NORMAL
// ============================================================

bot.on("message:location", async (ctx) => {
  const location = ctx.message.location;

  const latitude = location.latitude;
  const longitude = location.longitude;

  console.log(
    "📍 UBICACIÓN RECIBIDA:",
    ctx.from.id,
    latitude,
    longitude
  );

  const guardada = await guardarUbicacion(
    ctx.from.id,
    latitude,
    longitude
  );

  if (guardada) {
    await ctx.reply(
      "📍 Ubicación recibida. Ya apareces en el mapa."
    );
  } else {
    await ctx.reply(
      "Recibí tu ubicación, pero no tienes un turno activo. " +
      "Escribe /turno primero y después comparte tu ubicación."
    );
  }
});

// ============================================================
// UBICACIÓN EN VIVO
// ============================================================
//
// Telegram va actualizando el mensaje original de ubicación.
// Estas actualizaciones llegan como edited_message.
//
// ============================================================

bot.on(
  "edited_message:location",
  async (ctx) => {
    try {
      const location = ctx.editedMessage.location;

      const latitude = location.latitude;
      const longitude = location.longitude;

      console.log(
        "🔄 ACTUALIZACIÓN DE UBICACIÓN EN VIVO:",
        ctx.from.id,
        latitude,
        longitude
      );

      const guardada = await guardarUbicacion(
        ctx.from.id,
        latitude,
        longitude
      );

      console.log(
        "💾 Resultado actualización:",
        guardada
      );

    } catch (err) {
      console.error(
        "❌ Error procesando ubicación en vivo:",
        err
      );
    }
  }
);

// ============================================================
// ERRORES DEL BOT
// ============================================================

bot.catch((err) => {
  console.error(
    "❌ Error general del bot:",
    err
  );
});

// ============================================================
// MAPA WEB
// ============================================================

const app = express();

// ============================================================
// VALIDAR CLAVE DEL MAPA
// ============================================================

function claveValida(req) {
  return (
    req.query.clave &&
    req.query.clave === mapKey
  );
}

// ============================================================
// PÁGINA DEL MAPA
// ============================================================

app.get("/mapa", (req, res) => {
  if (!claveValida(req)) {
    res
      .status(403)
      .send(
        "Acceso denegado. Falta la clave correcta en el enlace."
      );

    return;
  }

  const clave = encodeURIComponent(
    req.query.clave
  );

  res.send(`
<!DOCTYPE html>

<html lang="es">

<head>

  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >

  <title>Driva - Mapa en vivo</title>

  <link
    rel="stylesheet"
    href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
  />

  <style>

    html,
    body {
      margin: 0;
      height: 100%;
      font-family: Arial, sans-serif;
    }

    #mapa {
      height: 100%;
      width: 100%;
    }

    #estado {
      position: absolute;
      top: 10px;
      left: 50px;
      z-index: 1000;

      background: white;

      padding: 10px 14px;

      border-radius: 8px;

      box-shadow:
        0 2px 8px rgba(0,0,0,0.25);

      font-size: 14px;

      line-height: 1.4;

      max-width: 320px;
    }

    .conductora-popup {
      font-size: 14px;
      line-height: 1.5;
    }

    .estado-verde {
      color: #16803c;
      font-weight: bold;
    }

    .estado-naranja {
      color: #c56a00;
      font-weight: bold;
    }

    .estado-rojo {
      color: #c62828;
      font-weight: bold;
    }

  </style>

</head>

<body>

  <div id="estado">
    Conectando con el servidor...
  </div>

  <div id="mapa"></div>

  <script
    src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js">
  </script>

  <script>

    // ========================================================
    // CREAR MAPA
    // ========================================================

    const map = L.map("mapa").setView(
      [19.4326, -99.1332],
      12
    );

    L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        attribution:
          "&copy; OpenStreetMap"
      }
    ).addTo(map);

    // ========================================================
    // MARCADORES
    // ========================================================

    let marcadores = {};

    let primeraCarga = true;

    // ========================================================
    // CREAR MARCADOR
    // ========================================================

    function crearMarcador(
      lat,
      lng,
      estado
    ) {

      let color = "#16803c";

      if (estado === "naranja") {
        color = "#f59e0b";
      }

      if (estado === "rojo") {
        color = "#dc2626";
      }

      return L.circleMarker(
        [lat, lng],
        {
          radius: 10,

          fillColor: color,

          color: "#ffffff",

          weight: 3,

          opacity: 1,

          fillOpacity: 1
        }
      );
    }

    // ========================================================
    // OBTENER ESTADO DE ACTUALIZACIÓN
    // ========================================================

    function obtenerEstado(
      segundos
    ) {

      if (segundos <= 60) {
        return "verde";
      }

      if (segundos <= 180) {
        return "naranja";
      }

      return "rojo";
    }

    // ========================================================
    // ACTUALIZAR MAPA
    // ========================================================

    async function actualizar() {

      try {

        const response = await fetch(
          "/api/activos?clave=${clave}",
          {
            cache: "no-store"
          }
        );

        if (!response.ok) {
          throw new Error(
            "Error HTTP " + response.status
          );
        }

        const datos = await response.json();

        const ahora = Date.now();

        const conUbicacion =
          datos.filter(
            d =>
              d.lat !== null &&
              d.lng !== null
          );

        document
          .getElementById("estado")
          .innerHTML =
            "<strong>🚗 Driva - Mapa en vivo</strong><br>" +
            datos.length +
            " conductora(s) con turno activo<br>" +
            conUbicacion.length +
            " con ubicación<br>" +
            "Actualizado: " +
            new Date().toLocaleTimeString();

        const idsActuales =
          new Set();

        // ====================================================
        // ACTUALIZAR CONDUCTORAS
        // ====================================================

        datos.forEach(c => {

          if (
            c.lat === null ||
            c.lng === null
          ) {
            return;
          }

          idsActuales.add(
            String(c.telegram_id)
          );

          let segundos = 0;

          if (c.ultima_actualizacion) {

            const fecha =
              new Date(
                c.ultima_actualizacion
              );

            segundos = Math.max(
              0,
              Math.floor(
                (ahora - fecha.getTime()) / 1000
              )
            );
          }

          const estado =
            obtenerEstado(segundos);

          let textoTiempo;

          if (segundos < 60) {

            textoTiempo =
              "hace " +
              segundos +
              " segundos";

          } else {

            textoTiempo =
              "hace " +
              Math.floor(
                segundos / 60
              ) +
              " minutos";
          }

          const estadoTexto =
            estado === "verde"
              ? "🟢 En tiempo real"
              : estado === "naranja"
                ? "🟠 Última ubicación reciente"
                : "🔴 Ubicación atrasada";

          const popupTexto =
            '<div class="conductora-popup">' +

            "<strong>" +
            c.nombre +
            "</strong><br>" +

            "🚗 Placas: " +
            c.placas +
            "<br>" +

            estadoTexto +
            "<br>" +

            "📍 Última ubicación: " +
            textoTiempo +

            "</div>";

          // ==================================================
          // SI YA EXISTE EL MARCADOR
          // ==================================================

          if (
            marcadores[c.telegram_id]
          ) {

            marcadores[
              c.telegram_id
            ].setLatLng([
              c.lat,
              c.lng
            ]);

            marcadores[
              c.telegram_id
            ].setStyle({
              fillColor:
                estado === "verde"
                  ? "#16803c"
                  : estado === "naranja"
                    ? "#f59e0b"
                    : "#dc2626"
            });

            marcadores[
              c.telegram_id
            ].setPopupContent(
              popupTexto
            );

          }

          // ==================================================
          // CREAR MARCADOR NUEVO
          // ==================================================

          else {

            marcadores[
              c.telegram_id
            ] =
              crearMarcador(
                c.lat,
                c.lng,
                estado
              )
              .addTo(map)
              .bindPopup(
                popupTexto
              );
          }

        });

        // ====================================================
        // ELIMINAR MARCADORES QUE YA NO ESTÁN ACTIVOS
        // ====================================================

        Object.keys(
          marcadores
        ).forEach(id => {

          if (
            !idsActuales.has(id)
          ) {

            map.removeLayer(
              marcadores[id]
            );

            delete marcadores[id];
          }

        });

        // ====================================================
        // CENTRAR MAPA EN LA PRIMERA CARGA
        // ====================================================

        if (
          primeraCarga &&
          Object.keys(marcadores).length > 0
        ) {

          const grupo =
            L.featureGroup(
              Object.values(marcadores)
            );

          map.fitBounds(
            grupo
              .getBounds()
              .pad(0.3)
          );

          primeraCarga = false;
        }

      } catch (error) {

        console.error(
          "Error actualizando mapa:",
          error
        );

        document
          .getElementById("estado")
          .innerHTML =
            "<strong>⚠️ Problema de conexión</strong><br>" +
            "No se pudo actualizar el mapa.<br>" +
            "Reintentando...";

      }

    }

    // ========================================================
    // PRIMERA CARGA
    // ========================================================

    actualizar();

    // ========================================================
    // ACTUALIZAR CADA 5 SEGUNDOS
    // ========================================================

    setInterval(
      actualizar,
      5000
    );

  </script>

</body>

</html>
  `);
});

// ============================================================
// API DE CONDUCTORAS ACTIVAS
// ============================================================

app.get(
  "/api/activos",
  async (req, res) => {

    if (!claveValida(req)) {

      res
        .status(403)
        .json({
          error: "clave inválida"
        });

      return;
    }

    try {

      const r = await pool.query(`
        SELECT
          c.telegram_id,
          c.nombre,
          c.placas,

          t.ultima_lat AS lat,
          t.ultima_lng AS lng,

          t.ultima_actualizacion,

          CASE
            WHEN t.ultima_actualizacion IS NULL
            THEN NULL
            ELSE EXTRACT(
              EPOCH FROM
              (NOW() - t.ultima_actualizacion)
            )
          END AS segundos_desde_actualizacion

        FROM turnos t

        JOIN conductoras c
          ON c.telegram_id = t.telegram_id

        WHERE t.estado = 'activo'

        ORDER BY
          t.ultima_actualizacion DESC NULLS LAST
      `);

      res
        .setHeader(
          "Cache-Control",
          "no-store"
        )
        .json(r.rows);

    } catch (err) {

      console.error(
        "Error al consultar activos:",
        err
      );

      res
        .status(500)
        .json({
          error: "error interno"
        });
    }
  }
);

// ============================================================
// INICIAR SERVIDOR
// ============================================================

async function main() {

  try {

    // Inicializar base de datos
    await initDb();

    // Iniciar bot
    bot.start({
      onStart: () => {
        console.log(
          "🤖 Bot iniciado correctamente"
        );
      }
    });

    // Puerto
    const port =
      process.env.PORT || 3000;

    // Servidor web
    app.listen(
      port,
      () => {

        console.log(
          "🌎 Servidor del mapa escuchando en el puerto " +
          port
        );

        console.log(
          "🗺️ Mapa disponible en /mapa"
        );

      }
    );

  } catch (err) {

    console.error(
      "❌ Error al iniciar:",
      err
    );

    process.exit(1);
  }
}

// ============================================================
// ARRANCAR
// ============================================================

main().catch(err => {

  console.error(
    "❌ Error fatal:",
    err
  );

  process.exit(1);

});
