// The board a reader can play on: guess the move the game went on to make, ask
// Stockfish what it would play from here, or take the position over and play
// the rest of the game out against it.
//
// All three modes need move input, which the viewer the book embeds cannot
// give. It is read-only by construction: it hard-codes draggable, selectable
// and movable off after its own options, and binds no drag listeners at all
// when it starts out view-only, so there is nothing to switch on afterwards.
// The modes therefore share a board of their own, mounted over the viewer and
// handed the position the viewer is showing. Leaving a mode throws that board
// away and puts the viewer back where it was.

import { Chessground } from './chessground.min.js';
import { Chess } from './chess.js';
import { SETS } from './pieces/sets.js';

const JUDGE_DEPTH = 10;   // deep enough to tell a blunder from a choice, and quick
const ANALYSE_DEPTH = 12; // the suggested moves, where a little more is worth it
const ENRICH_DEPTH = 10;  // the background replies: shallow, so they land fast
const CANDIDATES = 4;     // the moves Explore offers for the side to move
const REPLIES = 3;        // the answers it gathers for each of them
const MATE = 10000;       // a mate outscores any amount of material
const FULL = 20;          // the skill level every analysis asks for

// What the engine plays like as an opponent in a game against it. Skill Level
// is Stockfish's own handicap and a shallow search blunts it further: the point
// is a game a child can win, not a good one. Level 0 is no opponent at all.
const LEVELS = [null, { skill: 0, depth: 4 },
                      { skill: 3, depth: 8 },
                      { skill: 8, depth: 12 }];


// --- The engine ------------------------------------------------------------
// A megabyte and a half of WebAssembly, so it is started by the first guess
// that needs judging and never on a page that is only read. Single-threaded
// on purpose: the threaded builds want SharedArrayBuffer, which wants COOP and
// COEP headers, which GitHub Pages cannot send.
//
// Explore leans on MultiPV: one search returns the best few moves at once,
// each with the line that follows it. The same search answers both questions
// it asks -- what to play and what comes next -- and its `pv` supplies the
// reply that is shown before any background search has run.

let engine = null;

// The moves in a batch of `info ... multipv N ... pv ...` lines, one per
// index, the deepest reading the search reached for each. Nothing comes back
// from a position that is already over.
function pvs(lines) {
  const found = new Map();
  for (const line of lines) {
    const index = /\bmultipv (\d+)/.exec(line);
    const sc = /\bscore (cp|mate) (-?\d+)/.exec(line);
    const pv = /\bpv (.+)$/.exec(line);
    if (!index || !sc || !pv) continue;
    const moves = pv[1].trim().split(/\s+/);
    found.set(parseInt(index[1], 10), {
      uci: moves[0],
      pv: moves,
      score: { type: sc[1], n: parseInt(sc[2], 10) }
    });
  }
  return [...found.keys()].sort((a, b) => a - b).map(k => found.get(k));
}

function stockfish() {
  if (engine) return engine;

  const worker = new Worker(
    new URL('./stockfish-19-lite-single.js', import.meta.url));
  let pending = null;
  let searching = false;
  let gen = 0;

  worker.onmessage = e => {
    const line = typeof e.data === 'string' ? e.data : (e.data && e.data.data);
    if (!line || !pending) return;
    pending.lines.push(line);
    if (pending.until.test(line)) {
      const done = pending;
      pending = null;
      done.resolve(done.lines);
    }
  };

  const ask = (cmd, until) => new Promise(resolve => {
    pending = { lines: [], until, resolve };
    worker.postMessage(cmd);
  });

  // One worker answers one question at a time, so questions wait their turn.
  // A failed one must not jam the queue behind it.
  let turn = ask('uci', /^uciok/).then(() => ask('isready', /^readyok/));
  // A queued question is dropped whole if the reader has moved on by the time
  // its turn comes: it was asked about a position no longer on the board.
  const queued = fn => {
    const mine = gen;
    const run = () => (mine === gen ? fn() : null);
    const result = turn.then(run, run);
    turn = result.then(() => {}, () => {});
    return result;
  };

  // Every search says what it wants, because both options stick until they are
  // set again: MultiPV, and the skill, which an opponent playing to a handicap
  // turns down and every analysis puts back. `only` confines the search to one
  // move, which is how a move the engine would not have chosen can still be
  // scored from this side.
  const search = (fen, multipv, depth, only, skill = FULL) => {
    worker.postMessage('setoption name MultiPV value ' + multipv);
    worker.postMessage('setoption name Skill Level value ' + skill);
    worker.postMessage('position fen ' + fen);
    searching = true;
    return ask('go depth ' + depth + (only ? ' searchmoves ' + only : ''),
               /^bestmove/)
      .finally(() => { searching = false; });
  };

  engine = {
    // What the engine makes of a position, in centipawns, from the point of
    // view of whoever is to move in it.
    score(fen) {
      return queued(async () => {
        const lines = await search(fen, 1, JUDGE_DEPTH);
        // The last line carrying a score is the deepest the search reached;
        // the bestmove line that ends it carries none.
        for (let i = lines.length - 1; i >= 0; i--) {
          const m = /\bscore (cp|mate) (-?\d+)/.exec(lines[i]);
          if (!m) continue;
          const n = parseInt(m[2], 10);
          return m[1] === 'cp' ? n : n > 0 ? MATE - n : -MATE - n;
        }
        return 0;
      });
    },

    // The best few moves for the side to move, each with its own line. The
    // score is from that side's point of view, like score().
    candidates(fen) {
      return queued(async () =>
        pvs(await search(fen, CANDIDATES, ANALYSE_DEPTH)).slice(0, CANDIDATES));
    },

    // The best few answers to a move already made, from the position it
    // leaves; the score is from the answering side's point of view.
    replies(fen) {
      return queued(async () =>
        pvs(await search(fen, REPLIES, ENRICH_DEPTH)).slice(0, REPLIES));
    },

    // One named move's own line, whatever the engine thinks of it: the game's
    // move, when it is not one the engine would have proposed.
    candidate(fen, uci) {
      return queued(async () => pvs(await search(fen, 1, ANALYSE_DEPTH, uci))[0] || null);
    },

    // The move the engine plays as an opponent, handicapped to the chosen
    // level, as the two squares it moves between. Nothing comes back from a
    // position that is already over.
    reply(fen, level) {
      const { skill, depth } = LEVELS[level];
      return queued(async () => {
        const lines = await search(fen, 1, depth, null, skill);
        for (let i = lines.length - 1; i >= 0; i--) {
          const m = /^bestmove (\S+)/.exec(lines[i]);
          if (m) return m[1] === '(none)' ? null : m[1];
        }
        return null;
      });
    },

    // Drop everything not yet run and cut the search in flight, so a reader
    // who moves on does not wait behind answers to a position they left.
    abort() {
      gen++;
      if (searching) worker.postMessage('stop');
    }
  };
  return engine;
}


// --- Rules and pieces ------------------------------------------------------

// Chessground asks, for every square a piece can leave, which squares it can
// reach. chess.js knows, which keeps the rules in one place.
function destinations(chess) {
  const dests = new Map();
  for (const move of chess.moves({ verbose: true })) {
    const to = dests.get(move.from) || [];
    if (!to.includes(move.to)) to.push(move.to);
    dests.set(move.from, to);
  }
  return dests;
}

function promotionsFor(chess, from, to) {
  return chess.moves({ verbose: true })
    .filter(m => m.from === from && m.to === to && m.promotion)
    .map(m => m.promotion);
}

const ROLES = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };

// A pawn reaching the last rank asks what it becomes. The pieces are drawn by
// the viewer's own stylesheet, which wants each of them under a .cg-wrap.
function askPromotion(host, options, colour) {
  return new Promise(resolve => {
    const pane = document.createElement('div');
    pane.className = 'promo';
    for (const option of options) {
      const btn = document.createElement('button');
      btn.className = 'promo__pick';
      btn.title = ROLES[option];
      btn.innerHTML = '<span class="cg-wrap"><piece class="'
        + ROLES[option] + ' ' + colour + '"></piece></span>';
      btn.addEventListener('click', () => { pane.remove(); resolve(option); });
      pane.appendChild(btn);
    }
    host.appendChild(pane);
  });
}

// A move as UCI gives it, and back. UCI carries the promotion letter as a
// fifth character, which chess.js wants as its own field.
const decode = uci => ({
  from: uci.slice(0, 2),
  to: uci.slice(2, 4),
  promotion: uci.slice(4, 5) || undefined
});

function positionAfter(fen, uci) {
  const chess = new Chess(fen);
  chess.move(decode(uci));
  return chess.fen();
}

function sanIn(fen, uci) {
  const chess = new Chess(fen);
  const move = chess.move(decode(uci));
  return move ? move.san : uci;
}

// --- The pieces ------------------------------------------------------------
// The set is a class on the document and a line in localStorage, so a reader
// who prefers another keeps it across the whole book. Each set but the default
// is one stylesheet, fetched the first time it is chosen; a reader who never
// chooses fetches none, because the viewer's own stylesheet carries that one.

const PIECE_KEY = 'chess-pieces';
const DEFAULT_SET = SETS[0].id;
const fetched = new Set();

function storedSet() {
  try {
    const saved = localStorage.getItem(PIECE_KEY);
    return SETS.some(s => s.id === saved) ? saved : DEFAULT_SET;
  } catch { return DEFAULT_SET; }
}

function usePieces(id) {
  if (id !== DEFAULT_SET && !fetched.has(id)) {
    fetched.add(id);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./pieces/' + id + '.css', import.meta.url);
    document.head.appendChild(link);
  }
  for (const s of SETS)
    document.documentElement.classList.toggle('pieces-' + s.id, s.id === id);
}

export function initPieces() {
  usePieces(storedSet());
}

// The picker, and beside it whoever drew what is on the board: three of these
// sets are CC BY, which asks for the name, and the rest ask that their notice
// travel with them.
function picker() {
  const row = document.createElement('div');
  row.className = 'board-pieces';

  const label = document.createElement('label');
  label.className = 'board-pieces__label';
  label.htmlFor = 'board-pieces-select';
  label.textContent = 'Pieces';

  const select = document.createElement('select');
  select.id = 'board-pieces-select';
  select.title = 'The pieces';
  for (const set of SETS) {
    const option = document.createElement('option');
    option.value = set.id;
    option.textContent = set.id;
    select.appendChild(option);
  }

  const credit = document.createElement('span');
  credit.className = 'board-pieces__by';

  function show() {
    const set = SETS.find(s => s.id === select.value) || SETS[0];
    credit.textContent = set.by + ' \u00B7 ' + set.licence;
  }
  select.value = storedSet();
  show();

  select.addEventListener('change', () => {
    usePieces(select.value);
    try { localStorage.setItem(PIECE_KEY, select.value); } catch { /* private */ }
    show();
  });

  row.append(label, select, credit);
  return row;
}


// --- The three modes -------------------------------------------------------

const LEVEL_KEY = 'chess-engine-level';

// A game against the engine starts with an opponent, at the gentlest strength
// it has. Nothing saved means nobody has chosen yet, which is not the same as
// having turned the opponent off.
function storedLevel() {
  try {
    const saved = localStorage.getItem(LEVEL_KEY);
    if (saved === null) return 1;
    const n = Number(saved);
    return Number.isInteger(n) && n >= 0 && n < LEVELS.length ? n : 1;
  } catch { return 1; }
}

// How a guess is answered. The face is thrown over the board big enough to
// read from across a room, and says the same thing as the colour.
const GRADES = {
  right: { face: '🎉', why: 'the move the game made' },
  same:  { face: '👍', why: 'as good as the move the game made' },
  fair:  { face: '🤔', why: 'playable, but not what was played' },
  weak:  { face: '❌', why: 'it costs material' }
};

const colourOf = chess => (chess.turn() === 'w' ? 'white' : 'black');
const other = colour => (colour === 'white' ? 'black' : 'white');
const bare = san => san.replace(/[!?]+$/, '');

function button(label, title) {
  const btn = document.createElement('button');
  btn.className = 'board-bar__btn';
  btn.textContent = label;
  btn.title = title;
  return btn;
}

// An evaluation as a reader reads one: from White's side throughout, so the
// sign means the same thing at every depth of the tree. Mate folded.
function evaluation(score, white) {
  const n = white ? score.n : -score.n;
  if (score.type === 'mate') return n > 0 ? '#' + n : '#-' + Math.abs(n);
  const pawns = n / 100;
  return (pawns > 0 ? '+' : '') + pawns.toFixed(2);
}

export function attach({ boardEl, lpv, game }) {
  const column = boardEl.parentElement;
  // The viewer patches itself over the element it was handed, so it is found
  // rather than kept: what was passed to it is no longer in the page.
  const viewer = () => boardEl.querySelector('.lpv:not(.sandbox)');
  // The set is a preference, not a move, so it sits above the board and stays
  // put whichever mode the board is in.
  column.insertBefore(picker(), boardEl);

  const bar = document.createElement('div');
  bar.className = 'board-bar';
  boardEl.after(bar);

  // The tree, shown only while exploring. It goes below the box that names the
  // move on the board, so the proposals read as a continuation of it.
  const treeEl = document.createElement('div');
  treeEl.className = 'board-tree';
  treeEl.hidden = true;
  const head = document.createElement('div');
  head.className = 'board-tree__head';
  const crumb = document.createElement('div');
  crumb.className = 'board-tree__crumb';
  const list = document.createElement('ol');
  list.className = 'board-tree__list';
  treeEl.append(head, crumb, list);
  (column.querySelector('.move-text') || boardEl).after(treeEl);

  const guessBtn = button('Guess', 'Guess the next move');
  const exploreBtn = button('Explore', 'See what Stockfish suggests here');
  const playBtn = button('vs Stockfish',
                         'Play the rest of the game out against Stockfish');
  const vsBtn = button('vs', 'Let the engine answer');
  const undoBtn = button('↶', 'Take the move back');
  const onBtn = button('▸', 'Play the move and read on');
  const againBtn = button('▸?', 'Play the move and guess the next one');
  const backBtn = button('↩︎', 'Back to the game');
  const verdict = document.createElement('span');
  verdict.className = 'verdict';

  let mode = null;    // null, 'guess' or 'explore'
  let chess = null;   // the rules, from the position the mode started at
  let ground = null;
  let host = null;    // the frame put over the viewer
  let square = null;  // the board inside it
  let answer = null;  // in guess mode, the move the game actually made
  let resume = null;  // where the viewer was when the mode was entered
  let answered = false;   // a guess has been made and judged

  // Playing against the engine: how strong an opponent it is, and the colour
  // it answers as.
  let level = storedLevel();
  let side = null;

  // Explore, specifically: the line played from the position it started at,
  // and a cache so stepping back and forth does not re-ask the engine.
  let rootFen = null;
  let path = [];        // [{ uci, san }] from rootFen
  let entryPly = 0;     // where that position sits in the game, for the note
  let seq = 0;          // bumped whenever engine work in flight stops being
                        // wanted, so its answer is dropped when it lands
  const cache = new Map();   // fen -> { candidates, complete }

  function paint() {
    bar.textContent = '';
    if (!mode) {
      bar.append(guessBtn, exploreBtn, playBtn);
      guessBtn.disabled = !game.san[lpv.path.size()];
    } else if (mode === 'explore') {
      undoBtn.disabled = path.length === 0;
      bar.append(undoBtn, backBtn, verdict);
    } else if (mode === 'play') {
      // One button for the opponent: it says how strong he is, and pressing it
      // again strengthens him until it comes round to no opponent at all.
      vsBtn.textContent = 'vs' + (level ? ' ' + '•'.repeat(level) : '');
      vsBtn.setAttribute('aria-pressed', level ? 'true' : 'false');
      vsBtn.title = level ? 'The engine answers; again for a stronger one'
                          : 'Let the engine answer';
      undoBtn.disabled = !chess.history().length;
      verdict.textContent = chess.history().join(' ');
      verdict.className = 'verdict verdict--line';
      bar.append(undoBtn, vsBtn, backBtn, verdict);
    } else if (answered) {
      // The game is one move further on than the board: either way out of
      // here plays it, so a reader can read on or go straight to the next
      // question without first going back.
      againBtn.disabled = !game.san[resume.size() + 1];
      bar.append(onBtn, againBtn, backBtn, verdict);
    } else {
      bar.append(backBtn, verdict);
    }
  }

  function sync(lastMove) {
    ground.set({
      fen: chess.fen(),
      turnColor: colourOf(chess),
      check: chess.isCheck(),
      lastMove,
      movable: {
        color: chess.isGameOver() ? undefined : colourOf(chess),
        dests: destinations(chess)
      }
    });
  }

  // --- Guessing ------------------------------------------------------------

  // Judging a guess that is not the move the game made: the question is not
  // whether it differs but whether it costs anything, so the engine scores the
  // position each move leaves behind. Both scores are read from the guesser's
  // side, which is the side that is no longer to move once a move is made.
  async function judge(fen, after) {
    verdict.textContent = '…';
    verdict.className = 'verdict verdict--thinking';
    const played = new Chess(fen);
    played.move(answer);
    const sf = stockfish();
    const [mine, theirs] = await Promise.all([
      sf.score(after.fen()), sf.score(played.fen())
    ]);
    const cost = (-theirs) - (-mine);
    return cost <= 30 ? 'same' : cost <= 100 ? 'fair' : 'weak';
  }

  async function guessed(fen, move) {
    const right = bare(move.san) === bare(answer);
    let grade = right ? 'right'
      : chess.isCheckmate() ? 'same'
      : await judge(fen, chess);

    const { face, why } = GRADES[grade];
    verdict.className = 'verdict verdict--' + grade;
    verdict.textContent = right ? face + ' ' + answer
                                : face + ' ' + move.san + '  → ' + answer;
    verdict.title = why;

    const flash = document.createElement('div');
    flash.className = 'flash flash--' + grade;
    flash.textContent = face;
    square.appendChild(flash);
    setTimeout(() => flash.remove(), 1500);

    answered = true;
  }

  // --- Playing against the engine ------------------------------------------

  // The engine's answer, if one was asked for. It is fetched while the board
  // is frozen, and dropped if the reader takes the move back or leaves in the
  // meantime -- the first answer of all has a megabyte and a half to load.
  async function engineReply() {
    if (!level || chess.isGameOver() || colourOf(chess) !== side) return;
    const mine = ++seq;
    ground.set({ movable: { color: undefined } });
    verdict.textContent = chess.history().join(' ') + ' …';
    verdict.className = 'verdict verdict--line';
    const uci = await stockfish().reply(chess.fen(), level);
    if (mine !== seq || mode !== 'play') return;
    if (uci) {
      const from = uci.slice(0, 2), to = uci.slice(2, 4);
      chess.move({ from, to, promotion: uci.slice(4, 5) || undefined });
      sync([from, to]);
    }
    paint();
  }

  // --- Exploring -----------------------------------------------------------
  // Explore shows the engine's suggestions for the position on the board, with
  // its best answers to each, and the reader picks one -- or plays their own
  // move, which is treated the same. Picking a suggestion plays it and shows
  // the position it leads to, so the tree rolls forward one move at a time.

  function setStatus(text) {
    verdict.textContent = text;
    verdict.className = 'verdict' + (text ? ' verdict--line' : '');
  }

  // An arrow from a move, in chessground's own brushes: the candidate in blue,
  // the reply that hangs off it in yellow, so a hovered pair reads as two
  // moves rather than one. A candidate's arrow carries its rank, which is the
  // number on its card, so the board and the cards name the same four moves.
  const arrow = (uci, brush, rank) => ({
    orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush,
    label: rank ? { text: String(rank) } : undefined
  });

  // A span with its class and its text, which is most of what the tree is
  // made of.
  function span(cls, text) {
    const el = document.createElement('span');
    el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  // A score as one number, from the point of view of whoever is to move, with
  // mate folded in so that two of them compare whatever kind they are.
  const cp = score =>
    score.type === 'cp' ? score.n
      : score.n > 0 ? MATE - score.n : -MATE - score.n;

  // A move written as the move it is in the game, so the tree counts on from
  // where the reader entered rather than from one.
  const numbered = (san, ply) =>
    (Math.floor(ply / 2) + 1) + (ply % 2 ? '\u2026' : '.') + san;

  // Where a candidate stands against the engine's own first choice: the pawns
  // it gives up, and how much of a bar that leaves it. Four evaluations side
  // by side are four numbers, and the gap between them is what a reader is
  // trying to read off them; two pawns behind is as far as the bar goes.
  function standing(score, best) {
    const loss = (cp(best) - cp(score)) / 100;
    if (loss < .005) return { text: 'best', fill: 1 };
    // A mate on either side of the comparison is off any scale in pawns. The
    // evaluation beside the move says so itself, and the bar has only to put
    // the move last.
    if (score.type === 'mate' || best.type === 'mate')
      return { text: '', fill: 0 };
    return { text: '\u2212' + loss.toFixed(2), fill: Math.max(0, 1 - loss / 2) };
  }

  // A way back to the game at the position explored to, on the game's own
  // move, when the whole Path followed the game. Offered only once the reader
  // has actually walked the game forward.
  function returnButton() {
    const btn = document.createElement('button');
    btn.className = 'tree__return';
    btn.textContent = '↩︎';
    btn.title = 'Return to the game, ' + path.length + ' moves on';
    btn.addEventListener('click', () => leave(path.length));
    return btn;
  }

  function renderCrumb() {
    crumb.textContent = '';
    // The root names the move that produced the position Explore began at,
    // rather than a home icon, so the breadcrumb reads as a game line. At the
    // very start of a game there is no such move, and the icon stands in.
    const start = document.createElement('button');
    start.className = 'crumb__node crumb__root';
    start.title = 'the position you started from';
    if (entryPly > 0) {
      start.textContent = numbered(game.san[entryPly - 1], entryPly - 1);
    } else {
      start.textContent = '\u2302';
    }
    start.disabled = path.length === 0;
    start.addEventListener('click', () => goTo(0));
    crumb.appendChild(start);
    // Numbered by the move's real ply in the game, not by its place here, so a
    // reader who entered mid-game sees the moves they actually are.
    path.forEach((move, i) => {
      const ply = entryPly + i;
      const node = document.createElement('button');
      node.className = 'crumb__node';
      node.textContent = numbered(move.san, ply);
      node.disabled = i === path.length - 1;
      node.addEventListener('click', () => goTo(i + 1));
      crumb.appendChild(node);
    });
  }

  // The move the game itself made from this position, if the reader is still
  // on the game's line: once they play something else, there is no such move.
  // It comes back as UCI too, so it can be played like any proposal.
  function gameMove() {
    for (let i = 0; i < path.length; i++)
      if (bare(path[i].san) !== bare(game.san[entryPly + i] || '')) return null;
    const ply = entryPly + path.length;
    if (ply >= game.san.length) return null;
    const wanted = bare(game.san[ply]);
    for (const move of chess.moves({ verbose: true }))
      if (bare(move.san) === wanted)
        return { uci: move.from + move.to + (move.promotion || ''), san: move.san };
    return null;
  }

  // Each candidate is a card: its place in the engine's order, the move, what
  // the position is worth after it, and a bar saying how far short of the
  // engine's own choice it falls. The card's face is one button, so the whole
  // of it draws the move and plays it, from the keyboard as well as the mouse.
  function renderTree(node) {
    list.textContent = '';
    head.textContent = '';
    head.append(
      span('board-tree__who', (node.white ? 'White' : 'Black') + ' to move'),
      // What the cards do, said once. The arrows are drawn on hover, which is
      // not something a reader can be expected to try.
      span('board-tree__hint',
           'Stockfish\u2019s best \u2014 hover a move to see it, click to play it'));

    const played = gameMove();
    const playedSan = played ? bare(played.san) : null;
    const ply = entryPly + path.length;
    const best = node.candidates[0].score;

    // Every candidate is drawn from the moment the tree is, each carrying its
    // rank, because hovering is a thing only a mouse can do: on a phone a tap
    // plays the move, and an arrow a reader never sees is no suggestion at
    // all. The engine's own choice is solid and the rest are pale, so the
    // board ranks them the way the cards do. Hovering one narrows the board to
    // it; leaving puts the four back. A re-render rebuilds this, which is also
    // what takes away the arrow a hover was showing.
    const resting = node.candidates.map((c, i) =>
      arrow(c.uci, i === 0 ? 'blue' : 'paleBlue', i + 1));
    const show = shapes => () => ground.setAutoShapes(shapes);
    ground.setAutoShapes(resting);

    node.candidates.forEach((candidate, i) => {
      const isGame = playedSan !== null && bare(candidate.san) === playedSan;
      const place = standing(candidate.score, best);
      const li = document.createElement('li');
      li.className = 'tree__cand' + (i === 0 ? ' tree__cand--best' : '')
                                  + (isGame ? ' tree__cand--game' : '');

      const pick = document.createElement('button');
      pick.className = 'tree__pick';
      pick.title = 'Play ' + candidate.san;
      const top = span('tree__row');
      top.append(span('tree__rank', i + 1),
                 span('tree__san', numbered(candidate.san, ply)),
                 span('tree__eval', evaluation(candidate.score, node.white)));
      const gauge = span('tree__gauge');
      const fill = span('tree__fill');
      fill.style.width = Math.round(place.fill * 100) + '%';
      gauge.appendChild(fill);
      const foot = span('tree__foot');
      foot.append(gauge, span('tree__delta', place.text));
      pick.append(top, foot);
      // The move the game itself made, said in words: among four cards it is
      // the one a reader is looking for, and a pip did not say which.
      if (isGame) pick.appendChild(span('tree__tag', 'played in the game'));

      // Hovering a candidate draws it alone; hovering a reply draws it and
      // the candidate it hangs under, so the parent is never lost.
      const mine = [arrow(candidate.uci, 'blue', i + 1)];
      pick.addEventListener('click', () => advance([candidate.uci]));
      pick.addEventListener('mouseenter', show(mine));
      pick.addEventListener('mouseleave', show(resting));
      pick.addEventListener('focus', show(mine));
      pick.addEventListener('blur', show(resting));
      li.appendChild(pick);

      // The answers sit beneath their move and under a heading that says whose
      // they are, so the nesting does not have to be worked out.
      if (candidate.replies.length) {
        const answers = document.createElement('div');
        answers.className = 'tree__answers';
        answers.appendChild(span('tree__answers-head',
          (node.white ? 'Black' : 'White') + ' answers'));
        const ul = document.createElement('ul');
        ul.className = 'tree__replies';
        candidate.replies.forEach(reply => {
          const rli = document.createElement('li');
          const btn = document.createElement('button');
          btn.className = 'tree__reply'
            + (reply.score ? '' : ' tree__reply--pending');
          btn.title = 'Play ' + candidate.san + ' ' + reply.san;
          btn.append(span('tree__san', reply.san),
                     span('tree__eval', reply.score
                       ? evaluation(reply.score, !node.white) : ''));
          const both = [...mine, arrow(reply.uci, 'yellow')];
          btn.addEventListener('click', () =>
            advance([candidate.uci, reply.uci]));
          btn.addEventListener('mouseenter', show(both));
          btn.addEventListener('mouseleave', show(mine));
          btn.addEventListener('focus', show(both));
          btn.addEventListener('blur', show(resting));
          rli.appendChild(btn);
          ul.appendChild(rli);
        });
        answers.appendChild(ul);
        li.appendChild(answers);
      }
      if (isGame && path.length) li.appendChild(returnButton());
      list.appendChild(li);
    });
    renderCrumb();
  }

  function renderNone() {
    ground.setAutoShapes([]);
    list.textContent = '';
    head.textContent = '';
    head.appendChild(span('board-tree__who', 'Nothing to suggest'));
    const li = document.createElement('li');
    li.className = 'board-tree__none';
    li.textContent = 'No moves: the game is over in this position.';
    list.appendChild(li);
    renderCrumb();
  }

  // One node of the tree, from one line the engine returned: the move, its
  // score, and -- from the line's second move -- the first answer, shown
  // before any background search has run.
  function candidate(fen, line) {
    const child = positionAfter(fen, line.uci);
    const reply = line.pv && line.pv[1];
    return {
      uci: line.uci,
      san: sanIn(fen, line.uci),
      score: line.score,
      replies: reply
        ? [{ uci: reply, san: sanIn(child, reply), score: null }]
        : []
    };
  }

  function build(fen, batch) {
    const white = colourOf(new Chess(fen)) === 'white';
    return { candidates: batch.map(p => candidate(fen, p)), white, complete: false };
  }

  // The background searches: one per candidate, from the position it leaves,
  // adding the answers the first search did not have. They update the tree as
  // they land and are dropped whole if the reader has moved in the meantime.
  async function enrich(fen, node, mine) {
    const sf = stockfish();
    await Promise.all(node.candidates.map(async candidate => {
      const child = positionAfter(fen, candidate.uci);
      const replies = await sf.replies(child);
      if (mine !== seq || !replies) return;
      candidate.replies = replies.map(r => ({
        uci: r.uci, san: sanIn(child, r.uci), score: r.score
      }));
      renderTree(node);
    }));
    if (mine === seq) node.complete = true;
  }

  async function analyse() {
    treeEl.hidden = false;
    // The moves drawn for the position just left are not moves in this one.
    ground.setAutoShapes([]);
    const fen = chess.fen();
    const mine = ++seq;
    const first = !engine;
    const sf = stockfish();
    sf.abort();

    // The game's own move here, if the reader is still on its line. It is both
    // what the tree marks and what it may have to score itself; it is known
    // without the engine, so it can key the cache too.
    const played = gameMove();
    const key = fen + (played ? '|' + played.uci : '');

    const cached = cache.get(key);
    if (cached) {
      renderTree(cached);
      setStatus('');
      if (!cached.complete) enrich(fen, cached, mine);
      return;
    }

    setStatus(first ? 'loading…' : '…');
    const batch = await sf.candidates(fen);
    if (mine !== seq || !batch) return;
    if (!batch.length) { renderNone(); setStatus(''); return; }

    const node = build(fen, batch);

    // If the engine would not have played the game's move, it is scored all
    // the same and takes the weakest place among the four, so the reader can
    // weigh it on the same footing rather than as an unscored footnote.
    if (played && !node.candidates.some(c => bare(c.san) === bare(played.san))) {
      const line = await sf.candidate(fen, played.uci);
      if (mine !== seq) return;
      if (line) {
        node.candidates = node.candidates.slice(0, CANDIDATES - 1);
        node.candidates.push(candidate(fen, line));
      }
    }

    cache.set(key, node);
    renderTree(node);
    setStatus('');
    enrich(fen, node, mine);
  }

  // Play the moves and analyse what they lead to. A reply is two moves -- the
  // candidate it hangs under and the answer itself -- so picking one skips the
  // position between them.
  function advance(moves) {
    let last = null;
    for (const uci of moves) {
      const move = chess.move(decode(uci));
      if (!move) return;
      path.push({ uci, san: move.san });
      last = [uci.slice(0, 2), uci.slice(2, 4)];
    }
    sync(last);
    paint();
    analyse();
  }

  // Back to the n-th move of the line already played.
  function goTo(n) {
    chess = new Chess(rootFen);
    let last = null;
    for (let i = 0; i < n; i++) {
      const uci = path[i].uci;
      chess.move(decode(uci));
      last = [uci.slice(0, 2), uci.slice(2, 4)];
    }
    path = path.slice(0, n);
    sync(last);
    paint();
    analyse();
  }

  // --- Entering and leaving ------------------------------------------------

  async function moved(orig, dest) {
    const fen = chess.fen();
    const options = promotionsFor(chess, orig, dest);
    const promotion = options.length
      ? await askPromotion(square, options, colourOf(chess)) : undefined;
    const move = chess.move({ from: orig, to: dest, promotion });
    // Chessground has shown the piece arriving, but a castle moves a rook too,
    // a capture en passant clears a square the piece never touched, and a
    // promotion changes what landed, so the position is set from the rules.
    sync([orig, dest]);
    if (mode === 'guess') {
      ground.set({ movable: { color: undefined } });
      await guessed(fen, move);
      paint();
    } else if (mode === 'play') {
      paint();
      engineReply();
    } else if (mode === 'explore') {
      // A move the reader played rather than picked: it joins the line the
      // same way, and the engine is asked afresh from where it left off.
      path.push({ uci: orig + dest + (promotion || ''), san: move.san });
      paint();
      analyse();
    }
  }

  function enter(which) {
    if (which === 'guess' && !game.san[lpv.path.size()]) return;
    mode = which;
    resume = lpv.path;
    chess = new Chess(lpv.curData().fen);
    viewer().style.display = 'none';
    // The viewer's own frame, mounted the way it mounts its board: the grid
    // that sizes one sizes the other, so switching modes moves nothing.
    host = document.createElement('div');
    host.className = 'lpv lpv--moves-false sandbox';
    const area = document.createElement('div');
    area.className = 'lpv__board';
    square = document.createElement('div');
    area.appendChild(square);
    host.appendChild(area);
    boardEl.appendChild(host);
    ground = Chessground(square, {
      fen: chess.fen(),
      orientation: boardEl.dataset.orientation || 'white',
      turnColor: colourOf(chess),
      check: chess.isCheck(),
      addDimensionsCssVarsTo: host,
      animation: { enabled: true, duration: 180 },
      highlight: { lastMove: true, check: true },
      movable: {
        free: false,
        color: colourOf(chess),
        dests: destinations(chess),
        showDests: true,
        events: { after: moved }
      },
      draggable: { enabled: true, showGhost: true },
      selectable: { enabled: true },
      // Drawing is on only while exploring, where the arrows the tree draws
      // need it and a reader's own right-click arrows are a help rather than a
      // distraction.
      drawable: { enabled: which === 'explore' }
    });
    column.classList.add('is-' + which);
    verdict.textContent = '';
    verdict.className = 'verdict';
    answered = false;
    // The engine takes the side the reader is not about to move.
    side = which === 'play' ? other(colourOf(chess)) : null;
    if (which === 'guess') {
      answer = game.san[lpv.path.size()];
      verdict.className = 'verdict verdict--ask';
      verdict.textContent = colourOf(chess) === 'white' ? 'White?' : 'Black?';
    } else if (which === 'explore') {
      rootFen = chess.fen();
      entryPly = resume.size();
      path = [];
      analyse();
    }
    paint();
  }

  // Back to the game, `steps` plies along the mainline from where Explore was
  // entered -- 1 for a played move, 0 for none, or the whole explored Path when
  // it followed the game, so a reader who walked the game forward rejoins it.
  function leave(steps) {
    if (!mode) return;
    engine && engine.abort();
    seq++;
    ground.destroy();
    host.remove();
    viewer().style.display = '';
    column.classList.remove('is-guess', 'is-explore', 'is-play');
    treeEl.hidden = true;
    list.textContent = '';
    crumb.textContent = '';
    mode = null;
    chess = null;
    path = [];
    lpv.toPath(resume);
    for (let i = 0; i < (steps || 0); i++) lpv.goTo('next');
    paint();
  }

  guessBtn.addEventListener('click', () => enter('guess'));
  onBtn.addEventListener('click', () => leave(1));
  againBtn.addEventListener('click', () => { leave(1); enter('guess'); });
  exploreBtn.addEventListener('click', () => enter('explore'));
  playBtn.addEventListener('click', () => enter('play'));
  backBtn.addEventListener('click', () => leave(0));

  vsBtn.addEventListener('click', () => {
    level = (level + 1) % LEVELS.length;
    try { localStorage.setItem(LEVEL_KEY, level); } catch { /* private window */ }
    if (level === 1) side = other(colourOf(chess));
    paint();
  });

  // Exploring steps back along the line it has walked. A game against the
  // engine takes back its answer along with the reader's own move, so what
  // comes back is the reader's move to make again rather than the engine's.
  undoBtn.addEventListener('click', () => {
    if (mode === 'explore') {
      if (path.length) goTo(path.length - 1);
      return;
    }
    seq++;
    if (!chess.undo()) return;
    if (level && colourOf(chess) === side) chess.undo();
    const last = chess.history({ verbose: true }).slice(-1)[0];
    sync(last ? [last.from, last.to] : null);
    paint();
  });

  paint();
  // The viewer's own navigation decides whether there is a move left to guess.
  return { refresh: () => { if (!mode) paint(); } };
}
