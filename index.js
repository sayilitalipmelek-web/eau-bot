// Healthcheck + einfacher Telegram-Bot-Test
import http from "http";
import TelegramBot from "node-telegram-bot-api";

const PORT = process.env.PORT || 10000;

// Healthcheck Server (damit Render weiß, dass der Dienst läuft)
http.createServer((req, res) => res.end("ok")).listen(PORT, () => {
  console.log("✅ Server läuft auf Port", PORT);
});

// Telegram Bot
if (process.env.BOT_TOKEN) {
  const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
  bot.onText(/^\/ping$/, (msg) => bot.sendMessage(msg.chat.id, "pong ✅"));
  console.log("🤖 Bot läuft — sende /ping in Telegram zum Testen");
} else {
  console.log("⚠️ Kein BOT_TOKEN gesetzt — bitte auf Render hinzufügen!");
}
