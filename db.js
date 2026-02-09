const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DEFAULT_SQLITE_PATH = path.join(__dirname, 'database.sqlite');

function getDbPathFromEnv() {
  const url = process.env.DATABASE_URL;
  if (!url) return DEFAULT_SQLITE_PATH;

  if (url.startsWith('sqlite:')) {
    return url.replace('sqlite:', '');
  }

  // Fallback: treat as plain path
  return url;
}

const dbPath = getDbPathFromEnv();
const db = new Database(dbPath);

function initSchema() {
  const schemaPath = path.join(__dirname, 'db', 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    const sql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(sql);
  } else {
    // Fallback in case schema.sql is missing
    db.exec(`
      CREATE TABLE IF NOT EXISTS quizzes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        quiz_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        options TEXT NOT NULL,
        correct_option INTEGER NOT NULL,
        FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS answers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        quiz_id INTEGER NOT NULL,
        question_id INTEGER NOT NULL,
        selected_option INTEGER NOT NULL,
        correct INTEGER NOT NULL,
        timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE,
        FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
      );
    `);
  }

  seedExampleQuiz();
}

function seedExampleQuiz() {
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM quizzes');
  const { count } = countStmt.get();
  if (count > 0) return;

  const insertQuiz = db.prepare(
    'INSERT INTO quizzes (title, created_by) VALUES (?, ?)'
  );
  const insertQuestion = db.prepare(
    'INSERT INTO questions (quiz_id, text, options, correct_option) VALUES (?, ?, ?, ?)'
  );

  const quizTitle = 'Пример викторины: Основы Telegram';
  const adminId = 'system';

  const transaction = db.transaction(() => {
    const info = insertQuiz.run(quizTitle, adminId);
    const quizId = info.lastInsertRowid;

    insertQuestion.run(
      quizId,
      'Как называется официальный клиент мессенджера на смартфонах?',
      JSON.stringify(['Telegram', 'Telegraph', 'Telechat', 'MessageMe']),
      0
    );

    insertQuestion.run(
      quizId,
      'Что нужно сделать, чтобы начать общение с ботом?',
      JSON.stringify([
        'Найти бота по имени и нажать «Start»',
        'Написать в поддержку Telegram',
        'Включить VPN',
        'Добавить бота в контакты телефона'
      ]),
      0
    );
  });

  transaction();
}

initSchema();

// Data access layer – makes switching DBs easier later
const dal = {
  getAllQuizzes() {
    const stmt = db.prepare(
      'SELECT id, title, created_by, created_at FROM quizzes ORDER BY created_at DESC'
    );
    return stmt.all();
  },

  getQuizWithQuestions(quizId) {
    const quizStmt = db.prepare(
      'SELECT id, title, created_by, created_at FROM quizzes WHERE id = ?'
    );
    const quiz = quizStmt.get(quizId);
    if (!quiz) return null;

    const questionsStmt = db.prepare(
      'SELECT id, text, options, correct_option FROM questions WHERE quiz_id = ? ORDER BY id ASC'
    );
    const questions = questionsStmt.all(quizId).map((q) => ({
      ...q,
      options: JSON.parse(q.options)
    }));

    return { quiz, questions };
  },

  createQuiz(quizData) {
    const insertQuiz = db.prepare(
      'INSERT INTO quizzes (title, created_by) VALUES (?, ?)'
    );
    const insertQuestion = db.prepare(
      'INSERT INTO questions (quiz_id, text, options, correct_option) VALUES (?, ?, ?, ?)'
    );

    const transaction = db.transaction(() => {
      const info = insertQuiz.run(quizData.title, quizData.createdBy);
      const quizId = info.lastInsertRowid;

      for (const q of quizData.questions) {
        insertQuestion.run(
          quizId,
          q.text,
          JSON.stringify(q.options),
          q.correctOption
        );
      }

      return quizId;
    });

    return transaction();
  },

  saveQuizAnswers(userId, quizId, answers) {
    const insertAnswer = db.prepare(
      'INSERT INTO answers (user_id, quiz_id, question_id, selected_option, correct) VALUES (?, ?, ?, ?, ?)'
    );

    const transaction = db.transaction(() => {
      for (const a of answers) {
        insertAnswer.run(
          String(userId),
          quizId,
          a.questionId,
          a.selectedOption,
          a.correct ? 1 : 0
        );
      }
    });

    transaction();
  },

  getUserResults(userId, limit = 10) {
    const stmt = db.prepare(
      `
      SELECT
        q.id as quiz_id,
        q.title,
        COUNT(a.id) as total_answers,
        SUM(a.correct) as correct_answers,
        MAX(a.timestamp) as last_taken_at
      FROM answers a
      JOIN quizzes q ON a.quiz_id = q.id
      WHERE a.user_id = ?
      GROUP BY q.id, q.title
      ORDER BY last_taken_at DESC
      LIMIT ?
    `
    );

    return stmt.all(String(userId), limit);
  }
};

module.exports = dal;
