require('dotenv').config();

const express = require('express');
const path = require('path');
const morgan = require('morgan');
const cors = require('cors');
const { Telegraf } = require('telegraf');

const dal = require('./db');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is not set');
  process.exit(1);
}

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const WEB_APP_URL =
  process.env.WEB_APP_URL || 'https://your-repl-url-here.example';

const PORT = process.env.PORT || 3000;

// --- Express setup ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// API routes for Web App
app.get('/api/quizzes', (req, res) => {
  try {
    const quizzes = dal.getAllQuizzes();
    res.json({ quizzes });
  } catch (err) {
    console.error('Error fetching quizzes', err);
    res.status(500).json({ error: 'Ошибка при загрузке списка викторин' });
  }
});

app.get('/api/quizzes/:id', (req, res) => {
  try {
    const quizId = Number(req.params.id);
    const data = dal.getQuizWithQuestions(quizId);
    if (!data) {
      return res.status(404).json({ error: 'Викторина не найдена' });
    }
    res.json(data);
  } catch (err) {
    console.error('Error fetching quiz', err);
    res.status(500).json({ error: 'Ошибка при загрузке викторины' });
  }
});

// Serve React build
const distPath = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(distPath));

app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

// --- Telegraf bot setup ---
const bot = new Telegraf(BOT_TOKEN);

// Simple in-memory state for /create_quiz wizard
const adminStates = new Map();

function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

bot.start((ctx) => {
  const firstName = ctx.from.first_name || '';
  const hasValidWebAppUrl = WEB_APP_URL && 
    !WEB_APP_URL.includes('localhost') && 
    !WEB_APP_URL.includes('127.0.0.1') &&
    !WEB_APP_URL.includes('your-') &&
    !WEB_APP_URL.includes('example');

  let text = `Привет, ${firstName}!\n\n`;
  text += 'Здесь вы можете проходить простые викторины.\n\n';

  if (hasValidWebAppUrl) {
    text += 'Нажмите кнопку ниже, чтобы открыть список доступных викторин.';
  } else {
    text += '📱 Для использования веб-приложения:\n';
    text += `Откройте в браузере: http://localhost:${PORT}\n\n`;
    text += '💬 Доступные команды:\n';
    text += '/create_quiz - создать викторину (для админов)\n';
    text += '/results - посмотреть результаты';
  }

  // Показываем кнопку Web App только если URL валидный
  const replyMarkup = hasValidWebAppUrl
    ? {
        keyboard: [
          [
            {
              text: '📋 Открыть викторины',
              web_app: {
                url: WEB_APP_URL
              }
            }
          ]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
      }
    : undefined;

  return ctx.reply(text, replyMarkup ? { reply_markup: replyMarkup } : {});
});

bot.command('create_quiz', (ctx) => {
  const userId = String(ctx.from.id);
  if (!isAdmin(userId)) {
    return ctx.reply('У вас нет прав для создания викторин.');
  }

  adminStates.set(userId, {
    step: 'title',
    quiz: {
      title: '',
      questions: []
    }
  });

  return ctx.reply(
    'Создание новой викторины.\n\nПожалуйста, отправьте название викторины.'
  );
});

bot.command('results', (ctx) => {
  const userId = String(ctx.from.id);
  const results = dal.getUserResults(userId, 10);

  if (!results || results.length === 0) {
    return ctx.reply('У вас пока нет результатов викторин.');
  }

  let message = 'Ваши последние результаты:\n\n';
  for (const r of results) {
    message += `• «${r.title}»: ${r.correct_answers}/${r.total_answers} правильных ответов (последний раз: ${r.last_taken_at})\n`;
  }

  return ctx.reply(message);
});

// Handle messages for admin quiz creation and Web App data
bot.on('message', async (ctx) => {
  const userId = String(ctx.from.id);
  const message = ctx.message;

  // Handle Web App data (answers from frontend)
  if (message.web_app_data && message.web_app_data.data) {
    try {
      const payload = JSON.parse(message.web_app_data.data);
      if (payload.type === 'quiz_result') {
        const { quizId, answers } = payload;

        // Load quiz to calculate correctness
        const data = dal.getQuizWithQuestions(quizId);
        if (!data) {
          return ctx.reply('Не удалось найти викторину для сохранения результата.');
        }

        const byQuestionId = new Map();
        for (const q of data.questions) {
          byQuestionId.set(q.id, q);
        }

        const enrichedAnswers = answers.map((a) => {
          const q = byQuestionId.get(a.questionId);
          const correct = q && q.correct_option === a.selectedOption;
          return {
            questionId: a.questionId,
            selectedOption: a.selectedOption,
            correct
          };
        });

        dal.saveQuizAnswers(userId, quizId, enrichedAnswers);

        const correctCount = enrichedAnswers.filter((a) => a.correct).length;
        const totalCount = enrichedAnswers.length;

        await ctx.reply(
          `Результат сохранён.\n\nВы ответили правильно на ${correctCount} из ${totalCount} вопросов.`
        );
      }
    } catch (err) {
      console.error('Error handling web_app_data', err);
      await ctx.reply('Произошла ошибка при обработке результатов викторины.');
    }
    return;
  }

  // Admin quiz creation wizard
  if (!isAdmin(userId)) {
    return; // ignore other regular messages
  }

  const state = adminStates.get(userId);
  if (!state) {
    return;
  }

  const text = message.text?.trim();
  if (!text) {
    return ctx.reply('Пожалуйста, отправьте текстовое сообщение.');
  }

  if (state.step === 'title') {
    state.quiz.title = text;
    state.step = 'question_text';
    state.currentQuestion = { text: '', options: [], correctOption: 0 };
    return ctx.reply(
      'Отлично! Теперь отправьте текст первого вопроса.\n\nКогда захотите закончить, отправьте пустую строку вместо текста вопроса.'
    );
  }

  if (state.step === 'question_text') {
    if (text === '') {
      if (state.quiz.questions.length === 0) {
        return ctx.reply('Нужно добавить хотя бы один вопрос.');
      }

      const quizId = dal.createQuiz({
        title: state.quiz.title,
        createdBy: userId,
        questions: state.quiz.questions
      });

      adminStates.delete(userId);
      return ctx.reply(
        `Викторина успешно создана! ID: ${quizId}\n\nВы можете открыть её в веб‑приложении через /start.`
      );
    }

    state.currentQuestion.text = text;
    state.step = 'options';
    return ctx.reply(
      'Теперь отправьте варианты ответа для этого вопроса в одной строке, разделяя их точкой с запятой.\n\nНапример:\nВариант 1; Вариант 2; Вариант 3'
    );
  }

  if (state.step === 'options') {
    const parts = text
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean);

    if (parts.length < 2) {
      return ctx.reply('Нужно указать минимум два варианта ответа, разделённых точкой с запятой.');
    }

    state.currentQuestion.options = parts;
    state.step = 'correct_index';
    return ctx.reply(
      `Укажите номер правильного ответа (от 1 до ${parts.length}).`
    );
  }

  if (state.step === 'correct_index') {
    const index = Number(text);
    if (!Number.isInteger(index) || index < 1 || index > state.currentQuestion.options.length) {
      return ctx.reply(
        `Пожалуйста, введите число от 1 до ${state.currentQuestion.options.length}.`
      );
    }

    state.currentQuestion.correctOption = index - 1;
    state.quiz.questions.push({ ...state.currentQuestion });

    state.currentQuestion = { text: '', options: [], correctOption: 0 };
    state.step = 'question_text';

    return ctx.reply(
      'Вопрос сохранён.\n\nОтправьте текст следующего вопроса или нажмите кнопку для завершения.',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Завершить создание', callback_data: 'finish_quiz' }]
          ]
        }
      }
    );
  }
});

// Start bot (long polling) and HTTP server
(async () => {
  try {
    await bot.launch({ dropPendingUpdates: true }); // очищает старые обновления и не даёт 409
    console.log('Telegram bot started');
  } catch (err) {
    console.error('Failed to start Telegram bot', err);
    process.exit(1);
  }
})();


bot.action('finish_quiz', async (ctx) => {
  const userId = String(ctx.from.id);
  const state = adminStates.get(userId);

  if (!state) {
    return ctx.reply('Нет активного создания викторины.');
  }

  if (state.quiz.questions.length === 0) {
    return ctx.reply('Нужно добавить хотя бы один вопрос.');
  }

  const quizId = dal.createQuiz({
    title: state.quiz.title,
    createdBy: userId,
    questions: state.quiz.questions
  });

  adminStates.delete(userId);

  await ctx.editMessageReplyMarkup(); // убрать кнопку
  return ctx.reply(
    `Викторина успешно создана! ID: ${quizId}\n\nВы можете открыть её в веб-приложении через /start.`
  );
});


// Открытие веб приложения 

bot.command('open', (ctx) => {
  return ctx.reply('Открыть веб-приложение:', {
    reply_markup: {
      keyboard: [
        [
          {
            text: '📋 Открыть викторины',
            web_app: { url: WEB_APP_URL }
          }
        ]
      ],
      resize_keyboard: true
    }
  });
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
