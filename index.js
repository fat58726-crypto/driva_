const { Bot } = require("grammy");
const { Pool } = require("pg");

const token = process.env.BOT_TOKEN;
const databaseUrl = process.env.DATABASE_URL;

if (!token) {
  console.error("ERROR: no llegó la variable BOT_TOKEN al contenedor.");
  process.exit(1);
}
if (!databaseUrl) {
  console.error("ERROR: no llegó la variable DATABASE_URL al contenedor.");
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
  console.log("Tabla 'conductoras' lista");
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
    "/cancelar - Cancelar un registro en curso"
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

bot.catch((err) => console.error("Error del bot:", err.message));

async function main() {
  await initDb();
  bot.start();
  console.log("Bot iniciado correctamente");
}

main().catch((err) => {
  console.error("Error al iniciar:", err.message);
  process.exit(1);
});
