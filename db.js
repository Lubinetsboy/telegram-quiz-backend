const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

// --- ИНИЦИАЛИЗАЦИЯ СХЕМЫ ---

async function initSchema() {
  const schemaPath = path.join(__dirname, 'db', 'schema.sql');

  let sql;
  if (fs.existsSync(schemaPath)) {
    sql = fs.readFileSync(schemaPath, 'utf8');
  } else {
    sql = `
      CREATE TABLE IF NOT EXISTS quizzes (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS questions (
        id SERIAL PRIMARY KEY,
        quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        options JSONB NOT NULL,
        correct_option INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS answers (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        selected_option INTEGER NOT NULL,
        correct BOOLEAN NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
  }

  await pool.query(sql);
  await seedExampleQuiz();
}

// --- НАЧАЛЬНЫЕ ДАННЫЕ ---

async function seedExampleQuiz() {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM quizzes'
  );

  if (rows[0].count > 0) return;

  const quizTitle = 'Пример викторины: Основы Telegram';
  const adminId = 'system';

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const quizRes = await client.query(
      'INSERT INTO quizzes (title, created_by) VALUES ($1, $2) RETURNING id',
      [quizTitle, adminId]
    );

    const quizId = quizRes.rows[0].id;

    const questions = [
      {
        text: 'Как называется официальный клиент мессенджера на смартфонах?',
        options: ['Telegram', 'Telegraph', 'Telechat', 'MessageMe'],
        correct: 0
      },
      {
        text: 'Что нужно сделать, чтобы начать общение с ботом?',
        options: [
          'Найти бота по имени и нажать «Start»',
          'Написать в поддержку Telegram',
          'Включить VPN',
          'Добавить бота в контакты телефона'
        ],
        correct: 0
      }
    ];

    for (const q of questions) {
      await client.query(
        `
        INSERT INTO questions (quiz_id, text, options, correct_option)
        VALUES ($1, $2, $3, $4)
        `,
        [quizId, q.text, q.options, q.correct]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- DATA ACCESS LAYER ---

const dal = {
  async getAllQuizzes() {
    const { rows } = await pool.query(
      `
      SELECT id, title, created_by, created_at
      FROM quizzes
      ORDER BY created_at DESC
      `
    );
    return rows;
  },

  async getQuizWithQuestions(quizId) {
    const quizRes = await pool.query(
      `
      SELECT id, title, created_by, created_at
      FROM quizzes
      WHERE id = $1
      `,
      [quizId]
    );

    if (quizRes.rows.length === 0) return null;

    const questionsRes = await pool.query(
      `
      SELECT id, text, options, correct_option
      FROM questions
      WHERE quiz_id = $1
      ORDER BY id ASC
      `,
      [quizId]
    );

    return {
      quiz: quizRes.rows[0],
      questions: questionsRes.rows
    };
  },

  async createQuiz(quizData) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const quizRes = await client.query(
        `
        INSERT INTO quizzes (title, created_by)
        VALUES ($1, $2)
        RETURNING id
        `,
        [quizData.title, quizData.createdBy]
      );

      const quizId = quizRes.rows[0].id;

      for (const q of quizData.questions) {
        await client.query(
          `
          INSERT INTO questions (quiz_id, text, options, correct_option)
          VALUES ($1, $2, $3, $4)
          `,
          [quizId, q.text, q.options, q.correctOption]
        );
      }

      await client.query('COMMIT');
      return quizId;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async saveQuizAnswers(userId, quizId, answers) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (const a of answers) {
        await client.query(
          `
          INSERT INTO answers
          (user_id, quiz_id, question_id, selected_option, correct)
          VALUES ($1, $2, $3, $4, $5)
          `,
          [
            String(userId),
            quizId,
            a.questionId,
            a.selectedOption,
            !!a.correct
          ]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async getUserResults(userId, limit = 10) {
    const { rows } = await pool.query(
      `
      SELECT
        q.id AS quiz_id,
        q.title,
        COUNT(a.id) AS total_answers,
        SUM(CASE WHEN a.correct THEN 1 ELSE 0 END) AS correct_answers,
        MAX(a.timestamp) AS last_taken_at
      FROM answers a
      JOIN quizzes q ON a.quiz_id = q.id
      WHERE a.user_id = $1
      GROUP BY q.id, q.title
      ORDER BY last_taken_at DESC
      LIMIT $2
      `,
      [String(userId), limit]
    );

    return rows;
  }
};

// --- СТАРТ ---

initSchema()
  .then(() => console.log('Database initialized'))
  .catch(console.error);

module.exports = dal;
