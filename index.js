const { Bot } = require("grammy");
const { Pool } = require("pg");
const express = require("express");

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

const pool = new Pool({ connectionString: databaseUrl });

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

  console.log("Tablas listas: conductoras, turnos, grupos_alerta");
}

const bot = new Bot(token);

// Estado temporal en memoria mientras cada conductora completa su registro.
// Se pierde si el bot se reinicia a mitad de un registro; ella solo tendría que
// escribir /registro de nuevo.
const registrosEnCurso = new Map();

const PASOS = ["nombre", "placas", "tipo_sangre", "contacto"];

bot.command("start", (ctx) => {
  ctx.reply(
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

bot.command("registro", (ctx) => {
  const userId = ctx.from.id;
  registrosEnCurso.set(userId, { paso: 0, datos: {} });
  ctx.reply("Vamos a registrarte. Puedes escribir /cancelar en cualquier momento.\n\n¿Cuál es tu nombre completo?");
});

bot.command("cancelar", (ctx) => {
  const userId = ctx.from.id;
  if (registrosEnCurso.has(userId)) {
    registrosEnCurso.delete(userId);
    ctx.reply("Registro cancelado.");
  } else {
    ctx.reply("No tienes ningún registro en curso.");
  }
});

bot.command("perfil", async (ctx) => {
  const userId = ctx.from.id;
  try {
    const result = await pool.query(
      "SELECT nombre, placas, tipo_sangre, contacto_nombre, contacto_telefono FROM conductoras WHERE telegram_id = $1",
      [userId]
    );
    if (result.rows.length === 0) {
      ctx.reply("Todavía no estás registrada. Escribe /registro para empezar.");
      return;
    }
    const c = result.rows[0];
    ctx.reply(
      `Tu perfil:\n\n` +
      `Nombre: ${c.nombre}\n` +
      `Placas: ${c.placas}\n` +
      `Tipo de sangre: ${c.tipo_sangre}\n` +
      `Contacto de confianza: ${c.contacto_nombre} (${c.contacto_telefono})`
    );
  } catch (err) {
    console.error("Error al leer perfil:", err.message);
    ctx.reply("Hubo un problema al buscar tu perfil. Intenta de nuevo en un momento.");
  }
});

async function estaRegistrada(telegramId) {
  const r = await pool.query("SELECT 1 FROM conductoras WHERE telegram_id = $1", [telegramId]);
  return r.rows.length > 0;
}

async function turnoActivo(telegramId) {
  const r = await pool.query(
    "SELECT id FROM turnos WHERE telegram_id = $1 AND estado = 'activo' ORDER BY id DESC LIMIT 1",
    [telegramId]
  );
  return r.rows[0] || null;
}

bot.command("turno", async (ctx) => {
  const userId = ctx.from.id;

  if (!(await estaRegistrada(userId))) {
    ctx.reply("Primero necesitas registrarte. Escribe /registro.");
    return;
  }

  const activo = await turnoActivo(userId);
  if (activo) {
    ctx.reply("Ya tienes un turno activo. Escribe /fin cuando termines.");
    return;
  }

  await pool.query(
    "INSERT INTO turnos (telegram_id, estado, inicio) VALUES ($1, 'activo', NOW())",
    [userId]
  );

  ctx.reply(
    "Turno iniciado ✅\n\n" +
    "Ahora comparte tu ubicación en vivo:\n" +
    "1. Toca el clip 📎 (adjuntar)\n" +
    "2. Elige 'Ubicación'\n" +
    "3. Elige 'Compartir ubicación en vivo' y selecciona una duración (mínimo 1 hora)\n\n" +
    "Cuando termines tu turno, escribe /fin."
  );
});

bot.command("fin", async (ctx) => {
  const userId = ctx.from.id;
  const activo = await turnoActivo(userId);

  if (!activo) {
    ctx.reply("No tienes ningún turno activo.");
    return;
  }

  await pool.query(
    "UPDATE turnos SET estado = 'finalizado', fin = NOW() WHERE id = $1",
    [activo.id]
  );

  ctx.reply("Turno finalizado. Puedes dejar de compartir tu ubicación en vivo. Buen viaje 🚗");
});

// Registra el grupo actual como destino de alertas. Se ejecuta escribiendo
// este comando DENTRO del grupo de WhatsApp... digo, de Telegram.
bot.command("activar_alertas", async (ctx) => {
  if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") {
    ctx.reply("Este comando se usa dentro del grupo, no en privado.");
    return;
  }
  await pool.query(
    `INSERT INTO grupos_alerta (chat_id, nombre) VALUES ($1, $2)
     ON CONFLICT (chat_id) DO UPDATE SET nombre = EXCLUDED.nombre`,
    [ctx.chat.id, ctx.chat.title || "Grupo"]
  );
  ctx.reply("Listo, este grupo va a recibir las alertas de seguridad.");
});

bot.on("message:text", async (ctx) => {
  const userId = ctx.from.id;
  const texto = ctx.message.text.trim();

  if (texto.startsWith("/")) return; // los comandos ya se manejaron arriba

  const estado = registrosEnCurso.get(userId);
  if (!estado) {
    ctx.reply("No entendí eso. Escribe /registro para registrarte o /perfil para ver tus datos.");
    return;
  }

  const pasoActual = PASOS[estado.paso];

  if (pasoActual === "nombre") {
    estado.datos.nombre = texto;
    estado.paso++;
    ctx.reply("Perfecto. ¿Cuáles son tus placas?");
    return;
  }

  if (pasoActual === "placas") {
    estado.datos.placas = texto;
    estado.paso++;
    ctx.reply("¿Cuál es tu tipo de sangre? (ejemplo: O+, A-, etc.)");
    return;
  }

  if (pasoActual === "tipo_sangre") {
    estado.datos.tipo_sangre = texto;
    estado.paso++;
    ctx.reply("Por último, escribe el nombre y teléfono de tu contacto de confianza, separados por una coma.\nEjemplo: Laura Pérez, 5512345678");
    return;
  }

  if (pasoActual === "contacto") {
    const partes = texto.split(",");
    if (partes.length < 2) {
      ctx.reply("Necesito el nombre y el teléfono separados por una coma. Ejemplo: Laura Pérez, 5512345678");
      return;
    }
    const contactoNombre = partes[0].trim();
    const contactoTelefono = partes.slice(1).join(",").trim();

    try {
      await pool.query(
        `INSERT INTO conductoras (telegram_id, nombre, placas, tipo_sangre, contacto_nombre, contacto_telefono)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (telegram_id) DO UPDATE SET
           nombre = EXCLUDED.nombre,
           placas = EXCLUDED.placas,
           tipo_sangre = EXCLUDED.tipo_sangre,
           contacto_nombre = EXCLUDED.contacto_nombre,
           contacto_telefono = EXCLUDED.contacto_telefono`,
        [userId, estado.datos.nombre, estado.datos.placas, estado.datos.tipo_sangre, contactoNombre, contactoTelefono]
      );
      registrosEnCurso.delete(userId);
      ctx.reply("¡Listo! Quedaste registrada ✅\n\nEscribe /perfil para ver tus datos.");
    } catch (err) {
      console.error("Error al guardar conductora:", err.message);
      ctx.reply("Hubo un problema al guardar tu registro. Intenta de nuevo con /registro.");
    }
    return;
  }
});


async function guardarUbicacion(userId, lat, lng) {
  const activo = await turnoActivo(userId);
  if (!activo) return; // si no tiene turno activo, ignoramos la ubicación

  await pool.query(
    `UPDATE turnos SET ultima_lat = $1, ultima_lng = $2, ultima_actualizacion = NOW(), nivel_alerta = 0
     WHERE id = $3`,
    [lat, lng, activo.id]
  );
}

bot.on("message:location", async (ctx) => {
  const { latitude, longitude } = ctx.message.location;
  await guardarUbicacion(ctx.from.id, latitude, longitude);
});

// Las actualizaciones de "ubicación en vivo" llegan como ediciones de mensaje.
bot.on("edited_message:location", async (ctx) => {
  const { latitude, longitude } = ctx.editedMessage.location;
  await guardarUbicacion(ctx.from.id, latitude, longitude);
});

bot.catch((err) => console.error("Error del bot:", err.message));

// --- Mapa web ---
// Página protegida por una clave en la URL (?clave=...). No es una cuenta de
// usuario real, es solo para que el enlace no quede totalmente público.

const app = express();

function claveValida(req) {
  return req.query.clave && req.query.clave === mapKey;
}

app.get("/mapa", (req, res) => {
  if (!claveValida(req)) {
    res.status(403).send("Acceso denegado. Falta la clave correcta en el enlace.");
    return;
  }
  const clave = encodeURIComponent(req.query.clave);
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Driva - Mapa en vivo</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
  html, body { margin: 0; height: 100%; font-family: sans-serif; }
  #mapa { height: 100%; width: 100%; }
  #estado { position: absolute; top: 10px; left: 50px; z-index: 1000; background: white; padding: 6px 12px; border-radius: 6px; box-shadow: 0 1px 4px rgba(0,0,0,0.3); font-size: 14px; }
</style>
</head>
<body>
<div id="estado">Cargando...</div>
<div id="mapa"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  // Arregla un bug conocido de Leaflet: los íconos por defecto no cargan
  // bien cuando la página viene de un CDN, y el marcador queda invisible.
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
    iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
    shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  });

  const map = L.map('mapa').setView([19.4326, -99.1332], 12); // CDMX por defecto, mientras no hay datos
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  let marcadores = {};
  let primeraCarga = true;

  async function actualizar() {
    try {
      const r = await fetch('/api/activos?clave=${clave}');
      if (!r.ok) throw new Error('Error al pedir datos');
      const datos = await r.json();

      document.getElementById('estado').textContent =
        datos.length + ' conductora(s) en ruta - actualizado ' + new Date().toLocaleTimeString();

      const idsActuales = new Set();

      datos.forEach(c => {
        if (c.lat == null || c.lng == null) return;
        idsActuales.add(c.telegram_id);
        const popupTexto = c.nombre + '<br>Placas: ' + c.placas +
          '<br>Actualizado: ' + new Date(c.ultima_actualizacion).toLocaleTimeString();

        if (marcadores[c.telegram_id]) {
          marcadores[c.telegram_id].setLatLng([c.lat, c.lng]);
          marcadores[c.telegram_id].setPopupContent(popupTexto);
        } else {
          marcadores[c.telegram_id] = L.marker([c.lat, c.lng]).addTo(map).bindPopup(popupTexto);
        }
      });

      // Quitar marcadores de quien ya no está activa
      Object.keys(marcadores).forEach(id => {
        if (!idsActuales.has(Number(id))) {
          map.removeLayer(marcadores[id]);
          delete marcadores[id];
        }
      });

      // La primera vez que hay datos, mover la cámara para que se vean todas
      if (primeraCarga && Object.keys(marcadores).length > 0) {
        const grupo = L.featureGroup(Object.values(marcadores));
        map.fitBounds(grupo.getBounds().pad(0.3));
        primeraCarga = false;
      }
    } catch (e) {
      document.getElementById('estado').textContent = 'No se pudo actualizar (reintentando...)';
    }
  }

  actualizar();
  setInterval(actualizar, 15000);
</script>
</body>
</html>`);
});

app.get("/api/activos", async (req, res) => {
  if (!claveValida(req)) {
    res.status(403).json({ error: "clave inválida" });
    return;
  }
  try {
    const r = await pool.query(`
      SELECT c.telegram_id, c.nombre, c.placas, t.ultima_lat AS lat, t.ultima_lng AS lng, t.ultima_actualizacion
      FROM turnos t
      JOIN conductoras c ON c.telegram_id = t.telegram_id
      WHERE t.estado = 'activo'
      ORDER BY t.ultima_actualizacion DESC NULLS LAST
    `);
    res.json(r.rows);
  } catch (err) {
    console.error("Error al consultar activos:", err.message);
    res.status(500).json({ error: "error interno" });
  }
});

async function main() {
  await initDb();
  bot.start();
  console.log("Bot iniciado correctamente");

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log("Servidor del mapa escuchando en el puerto " + port);
  });
}

main().catch((err) => {
  console.error("Error al iniciar:", err.message);
  process.exit(1);
});
