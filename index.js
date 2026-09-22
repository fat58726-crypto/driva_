const { Bot } = require("grammy");

if (!process.env.BOT_TOKEN) {
  console.error("Falta la variable BOT_TOKEN");
  console.error("--- DIAGNOSTICO TEMPORAL ---");
  const nombres = Object.keys(process.env);
  console.error("Total de variables recibidas:", nombres.length);
  console.error("Nombres de variables recibidas:", nombres.join(", "));
  const parecidas = nombres.filter((n) => n.toUpperCase().includes("BOT") || n.toUpperCase().includes("TOKEN"));
  console.error("Variables que contienen BOT o TOKEN:", parecidas.length ? parecidas.join(", ") : "ninguna");
  console.error("--- FIN DIAGNOSTICO ---");
  process.exit(1);
}

const bot = new Bot(process.env.BOT_TOKEN);

bot.command("start", (ctx) => ctx.reply("¡Hola! Estoy funcionando 🚗"));
bot.on("message", (ctx) => ctx.reply("Recibí: " + (ctx.message.text || "tu mensaje")));

bot.catch((err) => console.error("Error del bot:", err.message));

bot.start();
console.log("Bot iniciado");
