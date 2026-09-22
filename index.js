const { Bot } = require("grammy");

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error("ERROR: no llegó la variable BOT_TOKEN al contenedor.");
  process.exit(1);
}

console.log("Token recibido, longitud:", token.length, "caracteres");

const bot = new Bot(token);

bot.command("start", (ctx) => ctx.reply("¡Hola! Driva está funcionando 🚗"));
bot.on("message", (ctx) => ctx.reply("Recibí: " + (ctx.message.text || "tu mensaje")));

bot.catch((err) => console.error("Error del bot:", err.message));

bot.start();
console.log("Bot iniciado correctamente");
