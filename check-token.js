require('dotenv').config();

const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не найден в .env файле');
  process.exit(1);
}

if (BOT_TOKEN.length < 40) {
  console.error('❌ Токен слишком короткий. Проверьте, что токен скопирован полностью.');
  console.log(`   Текущая длина: ${BOT_TOKEN.length} символов`);
  process.exit(1);
}

console.log('🔍 Проверка токена бота...');
console.log(`   Длина токена: ${BOT_TOKEN.length} символов`);

const bot = new Telegraf(BOT_TOKEN);

bot.telegram
  .getMe()
  .then((me) => {
    console.log('✅ Токен валидный!');
    console.log(`   Имя бота: ${me.first_name}`);
    console.log(`   Username: @${me.username}`);
    console.log(`   ID: ${me.id}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Ошибка проверки токена:');
    if (err.response?.error_code === 401) {
      console.error('   Токен неверный или бот был удален');
    } else if (err.response?.error_code === 404) {
      console.error('   Токен не найден. Проверьте правильность токена.');
    } else {
      console.error(`   ${err.message}`);
    }
    process.exit(1);
  });
