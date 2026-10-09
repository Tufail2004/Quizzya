/* ============================================================
   arfuu data layer — QuizStore
   Tries the real backend (/api) first; if it can't be reached
   (e.g. static hosting with no server), it seamlessly falls back
   to a localStorage mock with the SAME shapes. Pages never care.

   All methods are async:

     QuizStore.list()                              -> { quizzes: [...] }
     QuizStore.create({title, creatorName, questions})
                                                    -> { id, secret, title, creatorName }
     QuizStore.get(id)                              -> public quiz (NO correct answers)
     QuizStore.addResponse(quizId, {playerName, picks})
                                                    -> { id, playerName, score, total,
                                                         percentage, createdAt, review[] }
     QuizStore.responses(quizId, secret)            -> { quiz, responses, stats }
     QuizStore.shareLink(id)                        -> absolute URL of take.html?id=

   review[] items: { text, options[], picked, correctIndex }
   ============================================================ */

const QuizStore = (() => {
  const API = '/api';
  const TIMEOUT_MS = 5000;

  // localStorage keys for the offline fallback
  const LS_QUIZZES = 'arfuu_quizzes';
  const LS_RESPONSES = 'arfuu_responses';
  const LS_SECRETS = 'arfuu_secrets'; // quizId -> dashboard secret (private!)

  // --- small utils -----------------------------------------------------------
  const uid = (prefix) =>
    prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function readLS(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  }
  function writeLS(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full / private mode — mock just won't persist */
    }
  }

  // fetch() with a timeout. Throws on network failure; returns parsed JSON.
  // HTTP errors (400/403/404) are NOT network failures — they carry a real
  // answer, so we surface them as Errors instead of falling back to mock.
  async function api(path, options = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(API + path, {
        ...options,
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  // Run the API call; on NETWORK failure (not HTTP error) use the mock.
  async function withFallback(apiCall, mockCall) {
    try {
      return await apiCall();
    } catch (err) {
      // A real API answer (validation, 404, 403) must reach the page as-is.
      // Only a dead/unreachable server falls back to the local mock.
      if (err instanceof TypeError || err.name === 'AbortError') {
        return mockCall();
      }
      throw err;
    }
  }

  // --- localStorage mock (same shapes as the API) -----------------------------
  function mockStrip(quiz) {
    return {
      id: quiz.id,
      title: quiz.title,
      creatorName: quiz.creatorName,
      questionCount: quiz.questions.length,
      questions: quiz.questions.map((q) => ({ text: q.text, options: q.options })),
      createdAt: quiz.createdAt,
    };
  }

  const mock = {
    list() {
      const quizzes = readLS(LS_QUIZZES, {});
      return {
        quizzes: Object.values(quizzes)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(mockStrip),
      };
    },
    create({ title, creatorName, questions }) {
      const quizzes = readLS(LS_QUIZZES, {});
      const secrets = readLS(LS_SECRETS, {});
      const id = uid('qz_');
      const secret = uid('sk_');
      quizzes[id] = {
        id,
        title: String(title).trim(),
        creatorName: String(creatorName).trim(),
        questions: questions.map((q) => ({
          text: String(q.text).trim(),
          options: q.options.map((o) => String(o).trim()),
          correctIndex: q.correctIndex,
        })),
        createdAt: new Date().toISOString(),
      };
      secrets[id] = secret;
      writeLS(LS_QUIZZES, quizzes);
      writeLS(LS_SECRETS, secrets);
      if (!readLS(LS_RESPONSES, null)) writeLS(LS_RESPONSES, {});
      return { id, secret, title: quizzes[id].title, creatorName: quizzes[id].creatorName };
    },
    get(id) {
      const quiz = readLS(LS_QUIZZES, {})[id];
      return quiz ? mockStrip(quiz) : null;
    },
    addResponse(quizId, { playerName, picks }) {
      const quiz = readLS(LS_QUIZZES, {})[quizId];
      if (!quiz) throw new Error('Quiz not found.');
      let score = 0;
      const review = quiz.questions.map((q, i) => {
        const picked = picks[i];
        if (picked === q.correctIndex) score += 1;
        return { text: q.text, options: q.options, picked, correctIndex: q.correctIndex };
      });
      const responses = readLS(LS_RESPONSES, {});
      const entry = {
        id: uid('rs_'),
        playerName: String(playerName).trim(),
        picks,
        score,
        total: quiz.questions.length,
        percentage: Math.round((score / quiz.questions.length) * 100),
        createdAt: new Date().toISOString(),
      };
      (responses[quizId] = responses[quizId] || []).push(entry);
      writeLS(LS_RESPONSES, responses);
      return { ...entry, review };
    },
    responses(quizId, secret) {
      const quiz = readLS(LS_QUIZZES, {})[quizId];
      if (!quiz) throw new Error('Quiz not found.');
      const secrets = readLS(LS_SECRETS, {});
      if (!secret || secrets[quizId] !== secret) throw new Error('Wrong dashboard secret.');
      const responses = (readLS(LS_RESPONSES, {})[quizId] || []).map((r) => ({ ...r, quizId }));
      const avgScore =
        responses.length === 0
          ? 0
          : Math.round((responses.reduce((s, r) => s + r.score, 0) / responses.length) * 10) / 10;
      return {
        quiz: {
          id: quiz.id,
          title: quiz.title,
          creatorName: quiz.creatorName,
          questionCount: quiz.questions.length,
          questions: quiz.questions.map((q) => ({
            text: q.text,
            options: q.options,
            correctIndex: q.correctIndex,
          })),
          createdAt: quiz.createdAt,
        },
        responses: [...responses].reverse(),
        stats: { questions: quiz.questions.length, responses: responses.length, avgScore },
      };
    },
  };

  // --- public API --------------------------------------------------------------
  return {
    list() {
      // Normalize: the API names the key `publicId`; the mock uses `id`.
      const normalize = (q) =>
        q && q.publicId && !q.id ? { ...q, id: q.publicId } : q;
      return withFallback(
        () => api('/quizzes').then((d) => ({ quizzes: d.quizzes.map(normalize) })),
        () => mock.list()
      );
    },
    create(input) {
      return withFallback(
        () =>
          api('/quizzes', { method: 'POST', body: JSON.stringify(input) }).then((d) => ({
            id: d.quiz.id,
            secret: d.secret,
            title: d.quiz.title,
            creatorName: d.quiz.creatorName,
          })),
        () => mock.create(input)
      );
    },
    async get(id) {
      const quiz = await withFallback(
        () =>
          api(`/quizzes/${encodeURIComponent(id)}`).then((d) => {
            const q = d.quiz;
            return q && q.publicId && !q.id ? { ...q, id: q.publicId } : q;
          }),
        () => mock.get(id)
      );
      if (!quiz) throw new Error('Quiz not found.');
      return quiz;
    },
    addResponse(quizId, input) {
      return withFallback(
        () =>
          api(`/quizzes/${encodeURIComponent(quizId)}/play`, {
            method: 'POST',
            body: JSON.stringify(input),
          }).then((d) => ({ ...d.response, review: d.review })),
        () => mock.addResponse(quizId, input)
      );
    },
    responses(quizId, secret) {
      return withFallback(
        () => api(`/quizzes/${encodeURIComponent(quizId)}/responses?secret=${encodeURIComponent(secret || '')}`),
        () => mock.responses(quizId, secret)
      );
    },
    // Absolute link friends open to play this quiz.
    shareLink(id) {
      return new URL(`take.html?id=${encodeURIComponent(id)}`, location.href).href;
    },
  };
})();

// --- tiny page helpers (shared by every page) ----------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Escape user text before injecting into HTML. Always use it for names,
// titles, questions and options.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

// Friendly date like "9 Oct 2026".
function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

// Bottom toast notification. Queues nicely if called rapidly.
let toastTimer = null;
function toast(msg) {
  let t = $('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
