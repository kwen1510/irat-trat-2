/**
 * IF-AT Extended App (Complete)
 *
 * Features:
 * 1) Teacher login & sign-up (session-based).
 * 2) Admin user: admin@ri.edu.sg => sees all, can manage teachers.
 * 3) Teachers see only their own quizzes.
 * 4) Create quiz => code => QR => students can join.
 * 5) Student quiz => must enter group name => order of picks stored.
 * 6) Teacher sees results => picks in numeric order.
 */

const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');

// Create express app
const app = express();
app.set('view engine', 'ejs');

// Parse URL-encoded forms
app.use(bodyParser.urlencoded({ extended: false }));

// ALSO parse JSON for student quiz "Finish" fetch:
app.use(express.json());

// Serve static files from /public if needed
app.use(express.static('public'));

// Session config
app.use(session({
  secret: 'some-random-secret-here',  // Change for production
  resave: false,
  saveUninitialized: false
}));

// Initialize SQLite
const db = new sqlite3.Database('database.db');

// --------------------------------------
// 1) Create/Upgrade Tables
// --------------------------------------

// teachers table (for multiple teacher accounts)
db.run(`
  CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT
  )
`);

// forms table (quizzes)
db.run(`
  CREATE TABLE IF NOT EXISTS forms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE,
    questionCount INTEGER,
    optionCount INTEGER,
    correctAnswers TEXT,
    createdBy TEXT,
    quizTitle TEXT
  )
`);

// submissions table: storing group picks
db.run(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    formId INTEGER,
    groupName TEXT,
    answers TEXT   -- JSON of picks array
  )
`);

// If no teachers exist => seed an admin
db.get('SELECT COUNT(*) AS count FROM teachers', (err, row) => {
  if (!err && row.count === 0) {
    db.run('INSERT INTO teachers (email, password) VALUES (?, ?)',
           ['admin@ri.edu.sg', 'Password1']);
    console.log('Seeded admin@ri.edu.sg / Password1');
  }
});

// --------------------------------------
// 2) Teacher Auth (Login, Signup)
// --------------------------------------

// GET /console => login page
app.get('/console', (req, res) => {
  if (req.session.teacherId) {
    return res.redirect('/console/dashboard');
  }
  res.render('login', { error: null });
});

// POST /console => check login
app.post('/console', (req, res) => {
  const { email, password } = req.body;

  db.get(
    'SELECT * FROM teachers WHERE email = ? AND password = ?',
    [email, password],
    (err, teacher) => {
      if (err) return res.send('DB error: ' + err.message);
      if (!teacher) {
        // invalid credentials => re-render login with error
        return res.render('login', {
          error: 'Invalid email or password. Please try again.'
        });
      }
      // success => session
      req.session.teacherId = teacher.id;
      req.session.teacherEmail = teacher.email;

      return res.redirect('/console/dashboard');
    }
  );
});

// GET /console/signup => show sign-up form
app.get('/console/signup', (req, res) => {
  if (req.session.teacherId) return res.redirect('/console/dashboard');
  res.render('signup', { error: null });
});

// POST /console/signup => create teacher
app.post('/console/signup', (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM teachers WHERE email = ?', [email], (err, existing) => {
    if (existing) {
      return res.render('signup', {
        error: 'This email is already registered. Try logging in.'
      });
    }
    db.run('INSERT INTO teachers (email, password) VALUES (?, ?)',
           [email, password],
           function(err2) {
             if (err2) {
               return res.send('Error creating account: ' + err2.message);
             }
             // auto-login
             db.get('SELECT * FROM teachers WHERE email = ?', [email], (err3, newT) => {
               if (newT) {
                 req.session.teacherId = newT.id;
                 req.session.teacherEmail = newT.email;
               }
               return res.redirect('/console/dashboard');
             });
           });
  });
});

// --------------------------------------
// 3) Teacher Dashboard
// --------------------------------------

// GET /console/dashboard => shows teacher forms (admin sees all)
app.get('/console/dashboard', (req, res) => {
  if (!req.session.teacherId) return res.redirect('/console');

  if (req.session.teacherEmail === 'admin@ri.edu.sg') {
    // admin => all forms
    db.all('SELECT * FROM forms', (err, rows) => {
      if (err) return res.send('Error retrieving forms: ' + err.message);
      res.render('dashboard', {
        forms: rows,
        teacherEmail: req.session.teacherEmail
      });
    });
  } else {
    // only see own forms
    db.all(
      'SELECT * FROM forms WHERE createdBy = ?',
      [req.session.teacherEmail],
      (err, rows) => {
        if (err) return res.send('Error retrieving forms: ' + err.message);
        res.render('dashboard', {
          forms: rows,
          teacherEmail: req.session.teacherEmail
        });
      }
    );
  }
});

// --------------------------------------
// 4) Manage Teachers (Admin Only)
// --------------------------------------

// GET /console/teachers => list + create teacher
app.get('/console/teachers', (req, res) => {
  if (!req.session.teacherId || req.session.teacherEmail !== 'admin@ri.edu.sg') {
    return res.redirect('/console/dashboard');
  }

  db.all('SELECT id, email FROM teachers', (err, teacherRows) => {
    if (err) return res.send('Error retrieving teachers: ' + err.message);
    res.render('teachers', { teachers: teacherRows });
  });
});

// POST /console/teachers => create teacher
app.post('/console/teachers', (req, res) => {
  if (!req.session.teacherId || req.session.teacherEmail !== 'admin@ri.edu.sg') {
    return res.redirect('/console/dashboard');
  }
  const { email, password } = req.body;
  db.run('INSERT INTO teachers (email, password) VALUES (?, ?)',
         [email, password],
         function(err) {
           if (err) {
             return res.send('Error creating teacher: ' + err.message);
           }
           return res.redirect('/console/teachers');
         });
});

// GET /console/deleteTeacher/:id => remove teacher
app.get('/console/deleteTeacher/:id', (req, res) => {
  if (!req.session.teacherId || req.session.teacherEmail !== 'admin@ri.edu.sg') {
    return res.redirect('/console/dashboard');
  }
  db.run('DELETE FROM teachers WHERE id = ?', [req.params.id], function(err) {
    if (err) {
      return res.send('Error deleting teacher: ' + err.message);
    }
    return res.redirect('/console/teachers');
  });
});

// --------------------------------------
// 5) Create / Delete Quizzes
// --------------------------------------

// GET /console/new => form to create
app.get('/console/new', (req, res) => {
  if (!req.session.teacherId) return res.redirect('/console');
  res.render('newForm');
});

// POST /console/new => store quiz
app.post('/console/new', (req, res) => {
  if (!req.session.teacherId) return res.redirect('/console');

  const { quizTitle, questionCount, optionCount, correctAnswers } = req.body;
  const code = uuidv4().split('-')[0]; // short code

  db.run(`
    INSERT INTO forms (code, questionCount, optionCount, correctAnswers, createdBy, quizTitle)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  [code, questionCount, optionCount, correctAnswers, req.session.teacherEmail, quizTitle],
  function(err) {
    if (err) return res.send('Error saving form: ' + err.message);
    return res.redirect('/console/dashboard');
  });
});

// GET /console/delete/:id => remove quiz if admin or creator
app.get('/console/delete/:id', (req, res) => {
  if (!req.session.teacherId) return res.redirect('/console');

  const quizId = req.params.id;
  const currentEmail = req.session.teacherEmail;

  // check ownership
  db.get('SELECT createdBy FROM forms WHERE id = ?', [quizId], (err, form) => {
    if (err) return res.send('Error checking form ownership: ' + err.message);
    if (!form) return res.send('Quiz not found!');

    if (currentEmail === 'admin@ri.edu.sg' || form.createdBy === currentEmail) {
      db.run('DELETE FROM forms WHERE id = ?', [quizId], function(err2) {
        if (err2) return res.send('Error deleting form: ' + err2.message);
        return res.redirect('/console/dashboard');
      });
    } else {
      return res.send(`
        <h3>Access Denied</h3>
        <p>You are not allowed to delete this quiz.</p>
        <p><a href="/console/dashboard">Back to Dashboard</a></p>
      `);
    }
  });
});

// --------------------------------------
// 6) Generate & Show QR
// --------------------------------------
app.get('/console/qr/:id', (req, res) => {
  if (!req.session.teacherId) return res.redirect('/console');
  const quizId = req.params.id;
  const currentEmail = req.session.teacherEmail;

  db.get('SELECT * FROM forms WHERE id = ?', [quizId], (err, row) => {
    if (err) return res.send('DB error: ' + err.message);
    if (!row) return res.send('Quiz not found!');

    if (currentEmail !== 'admin@ri.edu.sg' && row.createdBy !== currentEmail) {
      return res.send(`
        <h3>Access Denied</h3>
        <p>You are not allowed to view this quiz.</p>
        <p><a href="/console/dashboard">Back</a></p>
      `);
    }

    res.render('showQR', { form: row });
  });
});

// --------------------------------------
// 7) Show Results for a Quiz
// --------------------------------------
app.get('/console/results/:id', (req, res) => {
  if (!req.session.teacherId) {
    return res.redirect('/console');
  }
  const formId = req.params.id;

  // load form
  db.get('SELECT * FROM forms WHERE id = ?', [formId], (err, theForm) => {
    if (err) return res.send('DB error: ' + err.message);
    if (!theForm) return res.send('Form not found!');

    if (req.session.teacherEmail !== 'admin@ri.edu.sg' && theForm.createdBy !== req.session.teacherEmail) {
      return res.send(`
        <h3>Access Denied</h3>
        <p>You cannot view results for this quiz.</p>
        <p><a href="/console/dashboard">Back</a></p>
      `);
    }

    // find all submissions for this form
    db.all('SELECT * FROM submissions WHERE formId = ?', [formId], (err2, subs) => {
      if (err2) return res.send('Error loading submissions: ' + err2.message);

      let correctAnswersArr = theForm.correctAnswers.split(',');

      res.render('results', {
        form: theForm,
        submissions: subs,
        correctAnswers: correctAnswersArr
      });
    });
  });
});

// --------------------------------------
// 8) Logout
// --------------------------------------
app.get('/console/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/console');
  });
});

// --------------------------------------
// 9) Student Console
// --------------------------------------

// GET / => if ?code=..., auto-join; else show "studentHome.ejs"
app.get('/', (req, res) => {
  const code = req.query.code;
  if (code) {
    db.get('SELECT * FROM forms WHERE code = ?', [code], (err, row) => {
      if (err) return res.send('Error fetching code: ' + err.message);
      if (!row) {
        return res.send('<h3>Invalid code!</h3><p><a href="/">Go back</a></p>');
      }
      return res.render('studentQuiz', {
        code: row.code,
        questionCount: row.questionCount,
        optionCount: row.optionCount,
        correctAnswers: row.correctAnswers.split(','),
        quizTitle: row.quizTitle
      });
    });
  } else {
    res.render('studentHome');
  }
});

// POST /join => student typed code
app.post('/join', (req, res) => {
  const { code } = req.body;
  db.get('SELECT * FROM forms WHERE code = ?', [code], (err, row) => {
    if (err) return res.send('Error fetching code: ' + err.message);
    if (!row) {
      return res.send('<h3>Invalid code!</h3><p><a href="/">Go back</a></p>');
    }
    return res.render('studentQuiz', {
      code: row.code,
      questionCount: row.questionCount,
      optionCount: row.optionCount,
      correctAnswers: row.correctAnswers.split(','),
      quizTitle: row.quizTitle
    });
  });
});

// POST /submitResults => store group picks
app.post('/submitResults', (req, res) => {
  // Body { code, groupName, picks (string) }
  const { code, groupName, picks } = req.body;

  db.get('SELECT id FROM forms WHERE code = ?', [code], (err, formRow) => {
    if (err) return res.json({ success: false, error: err.message });
    if (!formRow) return res.json({ success: false, error: 'Invalid quiz code' });

    const formId = formRow.id;

    db.run(`
      INSERT INTO submissions (formId, groupName, answers)
      VALUES (?, ?, ?)
    `,
    [formId, groupName, picks],  // picks is a JSON string from the front-end
    function(err2) {
      if (err2) return res.json({ success: false, error: err2.message });
      return res.json({ success: true });
    });
  });
});

// --------------------------------------
// Start Server
// --------------------------------------
const listener = app.listen(process.env.PORT || 3000, () => {
  console.log('IF-AT app running on port ' + listener.address().port);
});
